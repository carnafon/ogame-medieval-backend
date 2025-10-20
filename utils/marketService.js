const pool = require('../db');

// Compute simple market price for a single resource using price_base and global stock
async function computeMarketPriceSingle(clientOrPool, typeName, amount, action = 'buy') {
  const client = clientOrPool.query ? clientOrPool : pool;
  const t = (typeName || '').toString().toLowerCase();
  const ptRes = await client.query('SELECT lower(name) as name, price_base FROM resource_types WHERE lower(name) = $1', [t]);
  if (!ptRes.rows.length) return null;
  const base = Number(ptRes.rows[0].price_base) || 0;
  if (!base || base <= 0) return null;
  const stockRes = await client.query(
    `SELECT COALESCE(SUM(ri.amount),0) as stock
     FROM resource_inventory ri
     JOIN resource_types rt ON ri.resource_type_id = rt.id
     WHERE lower(rt.name) = $1`,
    [t]
  );
  const stockBefore = Number((stockRes.rows[0] && stockRes.rows[0].stock) || 0);
  const K_BUY = 0.5, K_SELL = 0.3, MIN_PRICE = 1;
  let price = base;
  if ((action || 'buy') === 'buy') {
    const factor = 1 + K_BUY * (amount / Math.max(1, stockBefore));
    price = Math.max(MIN_PRICE, Math.round(base * factor));
  } else {
    const factor = 1 - K_SELL * (amount / Math.max(1, stockBefore + amount));
    price = Math.max(MIN_PRICE, Math.round(base * factor));
  }
  return { price, base, stockBefore };
}

// Perform an atomic trade using an existing client transaction (assumes caller manages BEGIN/COMMIT)
// Mirrors the logic used by /api/resources/trade but accepts a client parameter.
async function tradeWithClient(client, buyerId, sellerId, resourceName, pricePerUnit, qty) {
  const rtRes = await client.query('SELECT id, lower(name) as name FROM resource_types WHERE lower(name) = $1', [resourceName.toString().toLowerCase()]);
  if (!rtRes.rows.length) throw new Error('Unknown resource: ' + resourceName);
  const resourceTypeId = rtRes.rows[0].id;
  const goldRtRes = await client.query('SELECT id FROM resource_types WHERE lower(name) = $1', ['gold']);
  if (!goldRtRes.rows.length) throw new Error('Gold resource type missing');
  const goldTypeId = goldRtRes.rows[0].id;

  // Lock both participant rows (sorted to avoid deadlocks)
  const idsToLock = [buyerId, sellerId].map(id => parseInt(id, 10)).sort((a, b) => a - b);
  for (const eid of idsToLock) {
    await client.query(`SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`, [eid]);
  }

  // Load current snapshots via resourcesService
  const buyerInv = await require('./resourcesService').getResourcesWithClient(client, buyerId);
  const sellerInv = await require('./resourcesService').getResourcesWithClient(client, sellerId);

  const buyerGold = buyerInv['gold'] || 0;
  const sellerResource = sellerInv[resourceName.toString().toLowerCase()] || 0;

  const totalCost = Number(pricePerUnit) * qty;
  if (buyerGold < totalCost) throw new Error('Buyer lacks gold');
  if (sellerResource < qty) throw new Error('Seller lacks stock');

  // Apply adjustments atomically using resourcesService helper
  const resourcesService = require('./resourcesService');
  // buyer: -gold, +resource; seller: +gold, -resource
  await resourcesService.adjustResourcesWithClientGeneric(client, buyerId, { gold: -totalCost, [resourceName.toString().toLowerCase()]: qty });
  await resourcesService.adjustResourcesWithClientGeneric(client, sellerId, { gold: totalCost, [resourceName.toString().toLowerCase()]: -qty });

  // Return snapshot for both entities
  const snapshotBuyer = await resourcesService.getResourcesWithClient(client, buyerId);
  const snapshotSeller = await resourcesService.getResourcesWithClient(client, sellerId);
  const snapshot = {};
  snapshot[String(buyerId)] = snapshotBuyer;
  snapshot[String(sellerId)] = snapshotSeller;
  return snapshot;
}

module.exports = { computeMarketPriceSingle, tradeWithClient };

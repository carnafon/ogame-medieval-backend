const pool = require('../db');
const resourcesService = require('./resourcesService');

// Compute simple market price for a single resource using price_base and global stock
async function computeMarketPriceSingle(clientOrPool, typeName, amount, action = 'buy') {
  const client = clientOrPool.query ? clientOrPool : pool;
  const t = (typeName || '').toString().toLowerCase();
  const pbMap = await resourcesService.getPriceBaseMapWithClient(client);
    const base = Number(pbMap[t] || 0);
  if (!base || base <= 0) return null;
  const stockBefore = await resourcesService.getTotalStockForResourceWithClient(client, t);
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
  const rtRes = await resourcesService.getResourceTypeByNameWithClient(client, resourceName.toString().toLowerCase());
  if (!rtRes) throw new Error('Unknown resource: ' + resourceName);
  const resourceTypeId = rtRes.id;
  const goldRtRes = await resourcesService.getResourceTypeByNameWithClient(client, 'gold');
  if (!goldRtRes) throw new Error('Gold resource type missing');
  const goldTypeId = goldRtRes.id;

  // Lock both participant rows (sorted to avoid deadlocks)
  const idsToLock = [buyerId, sellerId].map(id => parseInt(id, 10)).sort((a, b) => a - b);
  for (const eid of idsToLock) {
    await client.query(`SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`, [eid]);
  }

  // Load current snapshots via resourcesService
  const buyerInv = await resourcesService.getResourcesWithClient(client, buyerId);
  const sellerInv = await resourcesService.getResourcesWithClient(client, sellerId);

  const buyerGold = buyerInv['gold'] || 0;
  const sellerResource = sellerInv[resourceName.toString().toLowerCase()] || 0;

  const totalCost = Number(pricePerUnit) * qty;
  if (buyerGold < totalCost) throw new Error('Buyer lacks gold');
  if (sellerResource < qty) throw new Error('Seller lacks stock');

  // Apply adjustments atomically using resourcesService helper
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

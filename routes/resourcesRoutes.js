const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/resources?entityId=ID
// Devuelve los recursos de la entidad indicada
router.get('/', authenticateToken, async (req, res) => {
  const entityId = req.query.entityId || (req.user && req.user.entityId);
  if (!entityId) return res.status(400).json({ message: 'Falta entityId en la petición.' });

  try {
    const q = `SELECT rt.name, ri.amount
               FROM resource_inventory ri
               JOIN resource_types rt ON ri.resource_type_id = rt.id
               WHERE ri.entity_id = $1`;
    const result = await pool.query(q, [entityId]);
    const resources = Object.fromEntries(result.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
    res.json({ entityId: Number(entityId), resources });
  } catch (err) {
    console.error('Error al obtener recursos:', err.message);
    res.status(500).json({ message: 'Error al obtener recursos.', error: err.message });
  }
});

// POST /api/resources
// Body: { entityId, resources: { wood, stone, food } }
// Actualiza los valores de recursos (SET amount = provided) en una transacción
router.post('/', authenticateToken, async (req, res) => {
  const { entityId, resources } = req.body || {};
  if (!entityId || !resources) return res.status(400).json({ message: 'Faltan campos: entityId y resources.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // For update lock
    await client.query(`SELECT id FROM entities WHERE id = $1 FOR UPDATE`, [entityId]);
    // Update any provided resource by name; ignore unknown keys
    const existingTypesRes = await client.query(`SELECT id, name FROM resource_types`);
    const nameToId = Object.fromEntries(existingTypesRes.rows.map(r => [r.name.toLowerCase(), r.id]));

    for (const [k, v] of Object.entries(resources)) {
      // only update numeric values and known resource types
      if (typeof v !== 'number') continue;
      const lname = k.toLowerCase();
      const typeId = nameToId[lname];
      if (!typeId) continue; // skip unknown resource names

      await client.query(
        `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = $3`,
        [v, entityId, typeId]
      );
    }

    // Leer recursos actualizados
    const updated = await client.query(
      `SELECT rt.name, ri.amount
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE ri.entity_id = $1`,
      [entityId]
    );

    await client.query('COMMIT');

    const resourcesRes = Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
    res.json({ message: 'Recursos actualizados.', entityId: Number(entityId), resources: resourcesRes });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar recursos:', err.message);
    res.status(500).json({ message: 'Error al actualizar recursos.', error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/resource-types
// Devuelve los tipos de recursos definidos en la base de datos (incluye price_base)
router.get('/types', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, price_base FROM resource_types ORDER BY id');
    res.json({ resourceTypes: result.rows.map(r => ({ id: r.id, name: r.name, price_base: r.price_base })) });
  } catch (err) {
    console.error('Error al obtener tipos de recursos:', err.message);
    res.status(500).json({ message: 'Error al obtener tipos de recursos.', error: err.message });
  }
});

// POST /api/resources/market-price
// Body: { trades: [{ type: 'wood', amount: 10, action: 'buy'|'sell' }, ...] }
// Returns computed market price per trade based on global stock and price_base.
router.post('/market-price', async (req, res) => {
  try {
    const { trades } = req.body || {};
    if (!Array.isArray(trades) || trades.length === 0) {
      return res.status(400).json({ message: 'Debe enviar un array trades con al menos un elemento.' });
    }

    // Normalize names and unique list
    const names = Array.from(new Set(trades.map(t => (t.type || '').toString().toLowerCase()))).filter(Boolean);
    if (names.length === 0) return res.status(400).json({ message: 'No hay tipos de recurso válidos en trades.' });

    // Fetch price_base for each type
    const ptRes = await pool.query(
      `SELECT lower(name) as name, price_base FROM resource_types WHERE lower(name) = ANY($1)`,
      [names]
    );
    const baseMap = Object.fromEntries(ptRes.rows.map(r => [r.name, Number(r.price_base) || 0]));

    // Fetch global stock per resource (sum across all inventories)
    const stockRes = await pool.query(
      `SELECT lower(rt.name) as name, COALESCE(SUM(ri.amount),0) as stock
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE lower(rt.name) = ANY($1)
       GROUP BY lower(rt.name)`,
      [names]
    );
    const stockMap = Object.fromEntries(stockRes.rows.map(r => [r.name, Number(r.stock) || 0]));

    // Parameters for price formula
    const K_BUY = 0.5;   // elasticity for buying (market price increases when stock is low)
    const K_SELL = 0.3;  // elasticity for selling (market pays less when stock is high)
    const MIN_PRICE = 1; // minimum price

    const results = trades.map(tr => {
      const type = (tr.type || '').toString().toLowerCase();
      const amount = Math.max(0, parseInt(tr.amount || 0, 10));
      const action = (tr.action || 'buy').toString().toLowerCase();

      const base = baseMap[type] || 0;
      const stockBefore = stockMap[type] || 0;

      if (!base || base <= 0) {
        return { type, amount, action, base_price: null, price: null, stock_before: stockBefore, stock_after: stockBefore, note: 'missing base price' };
      }

      // Compute price using simple stock elasticity formula
      // Buying: player buys from market → price increases with relative amount
      // Selling: player sells to market → price decreases with relative amount
      let price = base;

      if (action === 'buy') {
        // price increases proportionally to amount / (stock + 1)
        const factor = 1 + K_BUY * (amount / Math.max(1, stockBefore));
        price = Math.max(MIN_PRICE, Math.round(base * factor));
      } else {
        // sell
        const factor = 1 - K_SELL * (amount / Math.max(1, stockBefore + amount));
        price = Math.max(MIN_PRICE, Math.round(base * factor));
      }

      const stockAfter = action === 'buy' ? Math.max(0, stockBefore - amount) : stockBefore + amount;
      return { type, amount, action, base_price: base, price, stock_before: stockBefore, stock_after: stockAfter };
    });

    res.json({ results });
  } catch (err) {
    console.error('Error computing market prices:', err.message);
    res.status(500).json({ message: 'Error computing market prices.', error: err.message });
  }
});

// POST /api/resources/trade
// Body: { buyerId, sellerId, resource: 'wood', price: 10, amount?: 1 }
// Performs an atomic trade: buyer pays gold -> seller, seller gives resource -> buyer
router.post('/trade', authenticateToken, async (req, res) => {
  const { buyerId, sellerId, resource, price, amount } = req.body || {};
  const qty = amount == null ? 1 : parseInt(amount, 10);

  if (!buyerId || !sellerId || !resource || price == null) {
    return res.status(400).json({ message: 'Faltan campos: buyerId, sellerId, resource, price. amount es opcional.' });
  }
  if (qty <= 0) return res.status(400).json({ message: 'La cantidad debe ser mayor que 0.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve resource type id (case-insensitive)
    const rtRes = await client.query('SELECT id, lower(name) as name FROM resource_types WHERE lower(name) = $1', [resource.toString().toLowerCase()]);
    if (rtRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Tipo de recurso desconocido: ${resource}` });
    }
    const resourceTypeId = rtRes.rows[0].id;
    const goldRtRes = await client.query('SELECT id FROM resource_types WHERE lower(name) = $1', ['gold']);
    if (goldRtRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ message: 'Tipo de recurso "gold" no encontrado en la base de datos.' });
    }
    const goldTypeId = goldRtRes.rows[0].id;

    // Lock buyer and seller inventory rows for the two resource types (resource and gold)
    // We lock all inventory rows for both entities to simplify and avoid deadlocks ordering issues by always locking in entity id order
    const idsToLock = [buyerId, sellerId].map(id => parseInt(id, 10)).sort((a, b) => a - b);

    for (const eid of idsToLock) {
      await client.query(
        `SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`,
        [eid]
      );
    }

    // Read current amounts
    const invRes = await client.query(
      `SELECT ri.entity_id, rt.id as resource_type_id, lower(rt.name) as name, ri.amount
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE ri.entity_id = ANY($1::int[]) AND (rt.id = $2 OR rt.id = $3)`,
      [[buyerId, sellerId], resourceTypeId, goldTypeId]
    );

    // Map: entity -> { resourceName: amount }
    const byEntity = {};
    for (const row of invRes.rows) {
      const eid = String(row.entity_id);
      if (!byEntity[eid]) byEntity[eid] = {};
      byEntity[eid][row.name] = parseInt(row.amount, 10);
    }

    const buyerInv = byEntity[String(buyerId)] || {};
    const sellerInv = byEntity[String(sellerId)] || {};

    const buyerGold = buyerInv['gold'] || 0;
    const sellerResource = sellerInv[resource.toString().toLowerCase()] || 0;

    const totalCost = Number(price) * qty;

    if (buyerGold < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Fondos insuficientes en comprador', have: buyerGold, need: totalCost });
    }
    if (sellerResource < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Stock insuficiente en vendedor', have: sellerResource, need: qty });
    }

    // Perform updates: subtract gold from buyer, add gold to seller, subtract resource from seller, add resource to buyer
    await client.query(
      `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = $3`,
      [totalCost, buyerId, goldTypeId]
    );
    await client.query(
      `UPDATE resource_inventory SET amount = amount + $1 WHERE entity_id = $2 AND resource_type_id = $3`,
      [totalCost, sellerId, goldTypeId]
    );

    await client.query(
      `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = $3`,
      [qty, sellerId, resourceTypeId]
    );
    await client.query(
      `UPDATE resource_inventory SET amount = amount + $1 WHERE entity_id = $2 AND resource_type_id = $3`,
      [qty, buyerId, resourceTypeId]
    );

    // Return updated snapshots for both entities
    const updatedRes = await client.query(
      `SELECT ri.entity_id, rt.name, ri.amount
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE ri.entity_id = ANY($1::int[])
       ORDER BY ri.entity_id, rt.id`,
      [[buyerId, sellerId]]
    );

    await client.query('COMMIT');

    const snapshot = {};
    for (const r of updatedRes.rows) {
      const eid = String(r.entity_id);
      if (!snapshot[eid]) snapshot[eid] = {};
      snapshot[eid][r.name.toLowerCase()] = parseInt(r.amount, 10);
    }

    res.json({ message: 'Trade ejecutado correctamente', buyerId: Number(buyerId), sellerId: Number(sellerId), resource: resource.toString().toLowerCase(), price: Number(price), amount: qty, snapshot });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('Error executing trade:', err && err.stack ? err.stack : err);
    res.status(500).json({ message: 'Error ejecutando trade', error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;



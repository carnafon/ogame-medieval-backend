const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const marketService = require('../utils/marketService');

// GET /api/resources?entityId=ID
// Devuelve los recursos de la entidad indicada
router.get('/', authenticateToken, async (req, res) => {
  const entityId = req.query.entityId || (req.user && req.user.entityId);
  if (!entityId) return res.status(400).json({ message: 'Falta entityId en la petición.' });

  try {
    const resources = await require('../utils/resourcesService').getResources(entityId);
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

  const resourcesService = require('../utils/resourcesService');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // lock entity row to coordinate with other entity-level ops via entityService
    const entityService = require('../utils/entityService');
    await entityService.lockEntity(client, entityId);
    const updated = await resourcesService.setResourcesWithClientGeneric(client, entityId, resources);
    await client.query('COMMIT');
    res.json({ message: 'Recursos actualizados.', entityId: Number(entityId), resources: updated });
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

    const results = [];
    for (const tr of trades) {
      const type = (tr.type || '').toString().toLowerCase();
      const amount = Math.max(0, parseInt(tr.amount || 0, 10));
      const action = (tr.action || 'buy').toString().toLowerCase();

      if (!type) {
        results.push({ type, amount, action, base_price: null, price: null, stock_before: null, stock_after: null, note: 'invalid type' });
        continue;
      }

      // Use marketService to compute price and stock
      const mp = await marketService.computeMarketPriceSingle(pool, type, amount, action);
      if (!mp) {
        // missing base price or unknown resource
        results.push({ type, amount, action, base_price: null, price: null, stock_before: null, stock_after: null, note: 'missing base price or unknown resource' });
        continue;
      }

      const stockAfter = action === 'buy' ? Math.max(0, mp.stockBefore - amount) : mp.stockBefore + amount;
      results.push({ type, amount, action, base_price: mp.base, price: mp.price, stock_before: mp.stockBefore, stock_after });
    }

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
    // Use marketService.tradeWithClient which now uses resourcesService internally
    const snapshot = await marketService.tradeWithClient(client, buyerId, sellerId, resource, price, qty);
    await client.query('COMMIT');
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



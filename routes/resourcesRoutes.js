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

    // Update each resource if provided
    const wood = typeof resources.wood === 'number' ? resources.wood : null;
    const stone = typeof resources.stone === 'number' ? resources.stone : null;
    const food = typeof resources.food === 'number' ? resources.food : null;

    if (wood !== null) {
      await client.query(
        `UPDATE resource_inventory
         SET amount = $1
         WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name = 'wood')`,
        [wood, entityId]
      );
    }
    if (stone !== null) {
      await client.query(
        `UPDATE resource_inventory
         SET amount = $1
         WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name = 'stone')`,
        [stone, entityId]
      );
    }
    if (food !== null) {
      await client.query(
        `UPDATE resource_inventory
         SET amount = $1
         WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name = 'food')`,
        [food, entityId]
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

module.exports = router;

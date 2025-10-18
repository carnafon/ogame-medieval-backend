const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const populationService = require('../utils/populationService');

// GET /api/population?entityId=ID
router.get('/', authenticateToken, async (req, res) => {
  const entityId = req.query.entityId ? Number(req.query.entityId) : null;
  if (!entityId) return res.status(400).json({ message: 'Falta entityId en la consulta.' });
  try {
    const summary = await populationService.getPopulationSummary(entityId);
    // Also return raw per-type rows for convenience (named `types` to match frontend expectation)
    const pool = require('../db');
    const rows = await pool.query('SELECT type, current_population, max_population, available_population FROM populations WHERE entity_id = $1', [entityId]);
    return res.json({ entityId, summary, types: rows.rows });
  } catch (err) {
    console.error('Error al obtener población:', err.message);
    return res.status(500).json({ message: 'Error al obtener población.', error: err.message });
  }
});

// POST /api/population
// Body: { entityId, updates: [{ type, current_population, max_population, available_population }] }
router.post('/', authenticateToken, async (req, res) => {
  const { entityId, updates } = req.body || {};
  if (!entityId || !Array.isArray(updates)) return res.status(400).json({ message: 'Faltan campos: entityId y updates.' });
  const client = await require('../db').connect();
  try {
    await client.query('BEGIN');
    const populationService = require('../utils/populationService');
    for (const u of updates) {
      const type = (u.type || '').toLowerCase();
      const cur = Number.isFinite(u.current_population) ? u.current_population : 0;
      const max = Number.isFinite(u.max_population) ? u.max_population : 0;
      let avail;
      if (Number.isFinite(u.available_population)) {
        avail = u.available_population;
      } else {
        // compute occupation from buildings for this entity and derive available = current - occupation
        const popUtils = require('../utils/populationService');
        const bres = await client.query('SELECT type, level, count FROM buildings WHERE entity_id = $1', [entityId]);
        const occupation = popUtils.computeOccupationFromBuildings(bres.rows || []);
        avail = Math.max(0, cur - occupation);
      }
      await populationService.setPopulationForTypeWithClient(client, entityId, type, cur, max, avail);
    }
    await client.query('COMMIT');
    const summary = await populationService.getPopulationSummary(entityId);
    // Return per-type rows to match GET and frontend expectation
    const pool = require('../db');
    const rows = await pool.query('SELECT type, current_population, max_population, available_population FROM populations WHERE entity_id = $1', [entityId]);
    return res.json({ message: 'Población actualizada.', entityId, summary, types: rows.rows });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Error actualizando población:', err.message);
    return res.status(500).json({ message: 'Error actualizando población.', error: err.message });
  } finally {
    try { client.release(); } catch (e) {}
  }
});

module.exports = router;

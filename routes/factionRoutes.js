const express = require('express');
const router = express.Router();
const pool = require('../db');

// 📦 GET /api/factions
router.get('/', async (req, res) => {
  const start = Date.now();
  console.log(`[factionRoutes] GET /api/factions from ${req.ip} - headers: ${JSON.stringify({ host: req.headers.host, origin: req.headers.origin })}`);
  try {
    const result = await pool.query('SELECT id, name FROM factions ORDER BY id');
    const duration = Date.now() - start;
    console.log(`[factionRoutes] DB returned ${result.rows.length} factions in ${duration}ms`);
    res.json(result.rows);
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[factionRoutes] Error obteniendo facciones after ${duration}ms:`, error && error.stack ? error.stack : error);
    // Return sanitized error to client but keep detailed stack in server logs
    res.status(500).json({ message: 'Error obteniendo facciones' });
  }
});

module.exports = router;

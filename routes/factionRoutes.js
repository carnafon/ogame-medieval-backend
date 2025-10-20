const express = require('express');
const router = express.Router();
const pool = require('../db');

// 📦 GET /api/factions
router.get('/', async (req, res) => {
  const start = Date.now();
  console.debug(`[factionRoutes] GET /api/factions from ${req.ip} - headers: ${JSON.stringify({ host: req.headers.host, origin: req.headers.origin })}`);
  try {
  console.debug('[factionRoutes] About to run DB query. Pool status:', { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
    // Wrap the DB query with a timeout so we can detect hangs
    const qPromise = pool.query('SELECT id, name FROM factions ORDER BY id');
    const timeoutMs = 7000;
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('DB_QUERY_TIMEOUT')), timeoutMs));
    const result = await Promise.race([qPromise, timeoutPromise]);
    const duration = Date.now() - start;
  console.debug(`[factionRoutes] DB returned ${result.rows.length} factions in ${duration}ms`);
    res.json(result.rows);
  } catch (error) {
    const duration = Date.now() - start;
    if (error && error.message === 'DB_QUERY_TIMEOUT') {
      console.error(`[factionRoutes] DB query timeout after ${duration}ms. Pool status:`, { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
    } else {
      console.error(`[factionRoutes] Error obteniendo facciones after ${duration}ms:`, error && error.stack ? error.stack : error);
    }
    // Return sanitized error to client but keep detailed stack in server logs
    res.status(500).json({ message: 'Error obteniendo facciones' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const pool = require('../db');

// 📦 GET /api/factions
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM factions ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('Error obteniendo facciones:', error);
    res.status(500).json({ message: 'Error obteniendo facciones' });
  }
});

module.exports = router;

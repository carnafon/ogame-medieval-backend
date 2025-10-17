const express = require('express');
const router = express.Router();
const { getBuildings } = require('../utils/buildingsService');
const { authenticateToken } = require('../middleware/auth');

// GET /api/entities/:id/buildings
router.get('/:id/buildings', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid entity id' });
  try {
    const buildings = await getBuildings(id);
    res.json({ entityId: id, buildings });
  } catch (err) {
    console.error('Error fetching buildings for entity', id, err.message);
    res.status(500).json({ message: 'Error fetching buildings' });
  }
});

module.exports = router;

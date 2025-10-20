const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const aiCityService = require('../utils/ai_city_service');
const aiEngine = require('../jobs/ai_economic_engine_v2');

// List AI cities
router.get('/', authenticateToken, async (req, res) => {
    try {
        const cities = await aiCityService.listCities(pool, false);
        res.json({ cities });
    } catch (err) {
        res.status(500).json({ message: 'Error listando AI cities', error: err.message });
    }
});

// Create a paired AI city (entity + ai_cities)
router.post('/', authenticateToken, async (req, res) => {
    const data = req.body || {};
    try {
        const result = await aiCityService.createPairedCity(pool, data);
        res.status(201).json({ message: 'AI City creada', ...result });
    } catch (err) {
        res.status(500).json({ message: 'Error creando AI City', error: err.message });
    }
});

// Delete AI city (and linked entity)
router.delete('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await aiCityService.deleteCityById(pool, id);
        if (!deleted) return res.status(404).json({ message: 'AI City no encontrada' });
        res.json({ message: 'AI City eliminada', deleted });
    } catch (err) {
        res.status(500).json({ message: 'Error eliminando AI City', error: err.message });
    }
});

// Trigger a single-city economic update (for testing) using v2
router.post('/:id/run', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await aiEngine.runCityTick(pool, Number(id));
        res.json({ message: 'AI city update (v2) triggered' });
    } catch (err) {
        res.status(500).json({ message: 'Error ejecutando update', error: err.message });
    }
});

module.exports = router;

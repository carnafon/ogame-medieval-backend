const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration } = require('../utils/gameUtils'); // Importamos funciones de utilidad
const { authenticateToken } = require('../middleware/auth'); // Importamos el middleware centralizado

// -----------------------------------------------------------------
// ⭐️ CONSTANTES
// -----------------------------------------------------------------

const POPULATION_CHANGE_RATE = 1; 

// Definir costes de construcción
const BUILDING_COSTS = {
    'house': { wood: 20, stone: 10, food: 5 },
    'sawmill': { wood: 50, stone: 30, food: 10 },
    'quarry': { wood: 40, stone: 80, food: 15 },
    'farm': { wood: 40, stone: 10, food: 10 }
};

// -----------------------------------------------------------------
// ⭐️ RUTAS PROTEGIDAS (authenticateToken se ejecuta en index.js)
// -----------------------------------------------------------------

// RUTA CONSTRUCCION
router.post('/build', async (req, res) => {
    // userId viene de req.user.id gracias al middleware authenticateToken en index.js
    const userId = req.user.id; 
    const { buildingType,entityId } = req.body; 
    console.log(`build request from user ${userId}:`, req.body);

    const cost = BUILDING_COSTS[buildingType];
    if (!cost) {
        console.warn(`Invalid buildingType received for user ${userId}:`, buildingType);
        return res.status(400).json({ message: 'Tipo de edificio no válido.' });
    }

    const client = await pool.connect(); 

    try {
        await client.query('BEGIN'); 

        // 1. Obtener recursos, población y timestamp del último update
     
        const currentResources = await client.query(
             'SELECT type, amount FROM resources WHERE entity_id = $1 FOR UPDATE',
            [entityId]
        );

        const resources = Object.fromEntries(resQuery.rows.map(r => [r.type, parseInt(r.amount, 10)]));
 // 2️⃣ Verificar si tiene recursos suficientes
        if (
            (resources.wood || 0) < cost.wood ||
            (resources.stone || 0) < cost.stone ||
            (resources.food || 0) < cost.food
        ) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Recursos insuficientes para construir.' });
        }

        // 3️⃣ Descontar recursos
        await client.query(
            `UPDATE resources SET amount = CASE
                WHEN type = 'wood' THEN amount - $1
                WHEN type = 'stone' THEN amount - $2
                WHEN type = 'food' THEN amount - $3
                ELSE amount END
             WHERE entity_id = $4`,
            [cost.wood, cost.stone, cost.food, entityId]
        );

        // 4️⃣ Crear el edificio
        await client.query(
            'INSERT INTO buildings (entity_id, type) VALUES ($1, $2)',
            [entityId, buildingType]
        );

        await client.query('COMMIT');
        res.status(200).json({ message: `Construcción de ${buildingType} completada.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en construcción:', err.message);
        res.status(500).json({ message: 'Error en la construcción.', error: err.message });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------------------
// ⚙️ RUTA: GENERAR RECURSOS
// -----------------------------------------------------------------

router.post('/generate-resources', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { entityId } = req.body;
    if (!entityId) return res.status(400).json({ message: 'Falta entityId.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1️⃣ Obtener edificios y recursos actuales
        const buildingsQuery = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE entity_id = $1 GROUP BY type',
            [entityId]
        );
        const buildings = buildingsQuery.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));

        const resourcesQuery = await client.query(
            'SELECT type, amount FROM resources WHERE entity_id = $1 FOR UPDATE',
            [entityId]
        );
        const resources = Object.fromEntries(resourcesQuery.rows.map(r => [r.type, parseInt(r.amount, 10)]));

        const entityQuery = await client.query(
            'SELECT id, population_current, population_max, last_resource_update FROM entities WHERE id = $1 FOR UPDATE',
            [entityId]
        );

        if (entityQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Entidad no encontrada.' });
        }

        const entity = entityQuery.rows[0];
        const now = new Date();
        const lastUpdate = entity.last_resource_update ? new Date(entity.last_resource_update) : now;
        const secondsElapsed = Math.floor((now - lastUpdate) / 1000);

        // 2️⃣ Producción acumulada
        const popStats = calculatePopulationStats(buildings, entity.population_current);
        const accrued = calculateProductionForDuration(buildings, popStats, secondsElapsed);

        // 3️⃣ Actualizar recursos acumulados
        const newWood = (resources.wood || 0) + accrued.wood;
        const newStone = (resources.stone || 0) + accrued.stone;
        const newFood = Math.max(0, (resources.food || 0) + accrued.food);

        await client.query(
            `UPDATE resources SET amount = CASE
                WHEN type = 'wood' THEN $1
                WHEN type = 'stone' THEN $2
                WHEN type = 'food' THEN $3
                ELSE amount END
             WHERE entity_id = $4`,
            [newWood, newStone, newFood, entityId]
        );

        // 4️⃣ Actualizar población y timestamp
        const netFood = accrued.food;
        let newPopulation = entity.population_current;
        if (netFood >= 0) newPopulation = Math.min(entity.population_max, newPopulation + POPULATION_CHANGE_RATE);
        else newPopulation = Math.max(1, newPopulation - POPULATION_CHANGE_RATE);

        await client.query(
            `UPDATE entities
             SET population_current = $1, last_resource_update = $2
             WHERE id = $3`,
            [newPopulation, now.toISOString(), entityId]
        );

        await client.query('COMMIT');
        res.status(200).json({
            message: 'Recursos actualizados correctamente.',
            resources: { wood: newWood, stone: newStone, food: newFood },
            population: { current: newPopulation, max: entity.population_max },
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en generate-resources:', err.message);
        res.status(500).json({ message: 'Error al generar recursos.', error: err.message });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------------------
// 🗺️ RUTA: MAPA
// -----------------------------------------------------------------

router.get('/map', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, x_coord, y_coord, user_id FROM entities');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error al obtener mapa:', err.message);
        res.status(500).json({ message: 'Error al obtener mapa.' });
    }
});

module.exports = router;
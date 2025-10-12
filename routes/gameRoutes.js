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
                        `SELECT rt.name AS type, ri.amount
                        FROM resource_inventory ri
                        JOIN resource_types rt ON ri.resource_type_id = rt.id
                        WHERE ri.entity_id = $1
                        FOR UPDATE`,
                        [entityId]
                    );

                    const resources = Object.fromEntries(
                        currentResources.rows.map(r => [r.type.toLowerCase(), parseInt(r.amount, 10)])
                    );

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
            `UPDATE resource_inventory SET amount = CASE
                WHEN (SELECT id FROM resource_types WHERE name = 'wood') THEN $1
                WHEN (SELECT id FROM resource_types WHERE name = 'stone') THEN $2
                WHEN (SELECT id FROM resource_types WHERE name = 'food') THEN $3
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


    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Obtener entidad del usuario
        const entityRes = await client.query(
             'SELECT id, current_population, max_population, last_resource_update FROM entities WHERE user_id = $1 LIMIT 1',
            [userId]
        );


         if (entityRes.rows.length === 0) {
        client.release();
        return res.status(404).json({ message: 'No se encontró entidad asociada al usuario.' });
         }

    const entity = entityRes.rows[0];
    const entityId = entity.id;



         // Obtener recursos actuales
        const resourcesQuery = await client.query(
            `SELECT rt.name, ri.amount
             FROM resource_inventory ri
             JOIN resource_types rt ON ri.resource_type_id = rt.id
             WHERE ri.entity_id = $1 FOR UPDATE`,
            [entityId]
        );


 const resources = Object.fromEntries(
            resourcesQuery.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)])
        );

        // --- Calcula la producción (ejemplo) ---
        const now = new Date();
        const lastUpdate = entity.last_resource_update ? new Date(entity.last_resource_update) : now;
        const secondsElapsed = Math.floor((now - lastUpdate) / 1000);

        // Aquí deberías tener tu función de cálculo de recursos: calcula accrued
        const accrued = {
            wood: 1 * secondsElapsed,   // ejemplo: +1 madera por segundo
            stone: 1 * secondsElapsed,  // ejemplo
            food: 1 * secondsElapsed
        };

        // Actualizar recursos acumulados
        const newResources = {
            wood: (resources.wood || 0) + accrued.wood,
            stone: (resources.stone || 0) + accrued.stone,
            food: Math.max(0, (resources.food || 0) + accrued.food),
        };

        // Actualizar tabla resource_inventory
        await client.query(
            `UPDATE resource_inventory
             SET amount = CASE resource_type_id
                WHEN (SELECT id FROM resource_types WHERE name = 'wood') THEN $1
                WHEN (SELECT id FROM resource_types WHERE name = 'stone') THEN $2
                WHEN (SELECT id FROM resource_types WHERE name = 'food') THEN $3
                ELSE amount
             END
             WHERE entity_id = $4`,
            [newResources.wood, newResources.stone, newResources.food, entityId]
        );

        // Actualizar población y timestamp
        let newPopulation = entity.current_population; // ejemplo
        await client.query(
            `UPDATE entities
             SET current_population = $1, last_resource_update = $2
             WHERE id = $3`,
            [newPopulation, now.toISOString(), entityId]
        );

        await client.query('COMMIT');

        // Enviar la entidad completa con recursos al frontend
       res.status(200).json({
            message: 'Recursos actualizados correctamente.',
            entity: {
                id: entity.id,
                faction_id: entity.faction_id || null,
                faction_name: entity.faction_name || '',
                x_coord: entity.x_coord || 0,
                y_coord: entity.y_coord || 0,
                current_population: newPopulation,
                max_population: entity.max_population || 0,
                resources: newResources
            },
            population: {
                current_population: newPopulation,
                max_population: entity.max_population || 0,
                available_population: (entity.max_population || 0) - newPopulation
            }
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
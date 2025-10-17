const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { consumeResources } = require('../utils/resourcesService');
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
    
    const userId = req.user.id; 
    const { buildingType,entity } = req.body; 
    console.log(`build request from user ${userId}:`, req.body);
    console.log(`Entity : ${entity.id}, Building Type: ${buildingType}`);

    const costBase = BUILDING_COSTS[buildingType];
    if (!costBase) {
        console.warn(`Invalid buildingType received for user ${userId}:`, buildingType);
        return res.status(400).json({ message: 'Tipo de edificio no válido.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const buildingResult = await client.query(
            `SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1`,
            [entity.id, buildingType]
        );
        const currentLevel = buildingResult.rows.length > 0 ? buildingResult.rows[0].level : 0;
        const factor = 1.7;
        const cost = {
            wood: Math.ceil(costBase.wood * Math.pow(currentLevel + 1, factor)),
            stone: Math.ceil(costBase.stone * Math.pow(currentLevel + 1, factor)),
            food: Math.ceil(costBase.food * Math.pow(currentLevel + 1, factor)),
        };

        // Consume resources within this same transaction
        try {
            await require('../utils/resourcesService').consumeResourcesWithClient(client, entity.id, cost);
        } catch (err) {
            if (err && err.code === 'INSUFFICIENT') {
                await client.query('ROLLBACK');
                // Propagate a structured error with details from the resourcesService
                return res.status(400).json({
                    message: err.message || 'Recursos insuficientes para construir.',
                    code: err.code,
                    resource: err.resource || null,
                    need: err.need || null,
                    have: err.have || null
                });
            }
            throw err;
        }

        // 5️⃣ Incrementar nivel o crear edificio
        if (currentLevel > 0) {
            await client.query(
                `UPDATE buildings
                 SET level = level + 1
                 WHERE entity_id = $1 AND type = $2`,
                [entity.id, buildingType]
            );
        } else {
            await client.query(
                `INSERT INTO buildings (entity_id, type, level) VALUES ($1, $2, 1)`,
                [entity.id, buildingType]
            );
        }

        // 5️⃣ Obtener edificios actualizados
        const updatedBuildings = await client.query(
            'SELECT type, MAX(level) AS level FROM buildings WHERE entity_id = $1 GROUP BY type',
            [entity.id]
        );


        // 6️⃣ Obtener entidad actualizada (población, recursos)
        const updatedEntityRes = await client.query(
            'SELECT id, current_population, max_population, faction_id, x_coord, y_coord FROM entities WHERE id = $1',
            [entity.id]
        );
        const updatedEntity = updatedEntityRes.rows[0];

        // Obtener recursos actualizados
        const updatedResourcesRes = await client.query(
            `SELECT rt.name, ri.amount
             FROM resource_inventory ri
             JOIN resource_types rt ON ri.resource_type_id = rt.id
             WHERE ri.entity_id = $1`,
            [entity.id]
        );
        const updatedResources = Object.fromEntries(
            updatedResourcesRes.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)])
        );

        await client.query('COMMIT');

        // 7️⃣ Enviar respuesta completa al frontend
        res.status(200).json({
            message: `Construcción de ${buildingType} completada.`,
            entity: {
                id: updatedEntity.id,
                faction_id: updatedEntity.faction_id,
                x_coord: updatedEntity.x_coord,
                y_coord: updatedEntity.y_coord,
                current_population: updatedEntity.current_population,
                max_population: updatedEntity.max_population,
                resources: updatedResources
            },
            buildings: updatedBuildings.rows,
            population: {
                current_population: updatedEntity.current_population,
                max_population: updatedEntity.max_population,
                available_population: updatedEntity.max_population - updatedEntity.current_population
            }
        });

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
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'No se encontró entidad asociada al usuario.' });
         }

    const entity = entityRes.rows[0];
    const entityId = entity.id;



         // Obtener recursos actuales (servicio)
        const resources = await require('../utils/resourcesService').getResources(entityId);

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

    // Actualizar tabla resource_inventory usando el servicio centralizado (misma transacción)
    await require('../utils/resourcesService').setResourcesWithClient(client, entityId, newResources);

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
         const result = await pool.query(`
            SELECT 
    e.id,
    u.username AS name,
    e.x_coord,
    e.y_coord,
    e.user_id,
    e.faction_id,
    e.current_population,
    e.max_population,
    f.name AS faction_name, 
    -- Recursos en columnas separadas
    SUM(CASE WHEN rt.name = 'wood' THEN ri.amount ELSE 0 END) AS wood,
    SUM(CASE WHEN rt.name = 'stone' THEN ri.amount ELSE 0 END) AS stone,
    SUM(CASE WHEN rt.name = 'food' THEN ri.amount ELSE 0 END) AS food,
    -- Opcional: edificios en formato json
    json_agg(json_build_object('type', b.type, 'count', 1)) AS buildings
FROM entities e
JOIN users u ON u.id = e.user_id
JOIN factions f ON e.faction_id = f.id
JOIN resource_inventory ri ON e.id = ri.entity_id
JOIN resource_types rt ON ri.resource_type_id = rt.id
LEFT JOIN buildings b ON e.id = b.entity_id
WHERE rt.name IN ('wood','stone','food')
GROUP BY e.id, u.username, f.name;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error al obtener mapa:', err.message);
        res.status(500).json({ message: 'Error al obtener mapa.' });
    }
});

module.exports = router;
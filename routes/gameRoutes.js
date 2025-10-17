const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { consumeResources } = require('../utils/resourcesService');
const { getBuildings, getBuildingLevel } = require('../utils/buildingsService');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration } = require('../utils/gameUtils'); // Importamos funciones de utilidad
const { authenticateToken } = require('../middleware/auth'); // Importamos el middleware centralizado

// -----------------------------------------------------------------
// ⭐️ CONSTANTES
// -----------------------------------------------------------------

const POPULATION_CHANGE_RATE = 1; 

const { BUILDING_COSTS } = require('../constants/buildings');

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

        const currentLevel = await getBuildingLevel(entity.id, buildingType);
        const factor = 1.7;
        const cost = {
            wood: Math.ceil(costBase.wood * Math.pow(currentLevel + 1, factor)),
            stone: Math.ceil(costBase.stone * Math.pow(currentLevel + 1, factor)),
            food: Math.ceil(costBase.food * Math.pow(currentLevel + 1, factor)),
        };

        // Consume resources within this same transaction
        try {
            // Debug: log current resources before attempting to consume
            try {
                const currentRes = await client.query(
                    `SELECT rt.name, ri.amount
                     FROM resource_inventory ri
                     JOIN resource_types rt ON ri.resource_type_id = rt.id
                     WHERE ri.entity_id = $1`,
                    [entity.id]
                );
                const curObj = Object.fromEntries(currentRes.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
                console.log(`Current resources for entity ${entity.id}:`, curObj);
            } catch (logErr) {
                console.warn('Failed to read current resources for logging:', logErr.message);
            }
            await require('../utils/resourcesService').consumeResourcesWithClient(client, entity.id, cost);
        } catch (err) {
            if (err && err.code === 'INSUFFICIENT') {
                await client.query('ROLLBACK');
                // Log detailed info for debugging
                console.warn(`INSUFFICIENT resources for entity ${entity.id}:`, {
                    resource: err.resource || null,
                    need: err.need || null,
                    have: err.have || null,
                    message: err.message
                });
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
        const updatedBuildings = await getBuildings(entity.id);


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
    try {
        // Find user's entity id
        const er = await pool.query('SELECT id FROM entities WHERE user_id = $1 LIMIT 1', [userId]);
        if (er.rows.length === 0) return res.status(404).json({ message: 'No se encontró entidad asociada al usuario.' });
        const entityId = er.rows[0].id;

        // Call the central processor for a single entity
        const rg = require('../jobs/resourceGenerator');
    const result = await rg.processEntity(entityId, null);

    // processEntity already returns { message, entity, population }
    return res.status(200).json(result);
    } catch (err) {
        console.error('Error en generate-resources:', err.message);
        return res.status(500).json({ message: 'Error al generar recursos.', error: err.message });
    }
});

// -----------------------------------------------------------------
// 🗺️ RUTA: MAPA
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// RUTA: OBTENER COSTE DE CONSTRUCCIÓN
// GET /api/build/cost?buildingType=house&entityId=6
router.get('/build/cost', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const buildingType = req.query.buildingType;
    const entityId = req.query.entityId ? Number(req.query.entityId) : null;

    if (!buildingType) return res.status(400).json({ message: 'Falta buildingType en la consulta.' });

    try {
        // Determine entity id: prefer query, fallback to user's entity
        let targetEntityId = entityId;
        if (!targetEntityId) {
            const er = await pool.query('SELECT id FROM entities WHERE user_id = $1 LIMIT 1', [userId]);
            if (er.rows.length === 0) return res.status(404).json({ message: 'No se encontró entidad para el usuario.' });
            targetEntityId = er.rows[0].id;
        }

        const costBase = BUILDING_COSTS[buildingType];
        if (!costBase) return res.status(400).json({ message: 'Tipo de edificio no válido.' });

        // Find current level
        const br = await pool.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1', [targetEntityId, buildingType]);
        const currentLevel = br.rows.length > 0 ? br.rows[0].level : 0;
        const factor = 1.7;
        const cost = {
            wood: Math.ceil(costBase.wood * Math.pow(currentLevel + 1, factor)),
            stone: Math.ceil(costBase.stone * Math.pow(currentLevel + 1, factor)),
            food: Math.ceil(costBase.food * Math.pow(currentLevel + 1, factor)),
        };

        // Get current resources via service
        const resources = await require('../utils/resourcesService').getResources(targetEntityId);

        const canBuild = (resources.wood || 0) >= cost.wood && (resources.stone || 0) >= cost.stone && (resources.food || 0) >= cost.food;

        return res.status(200).json({ buildingType, entityId: targetEntityId, cost, resources, canBuild });
    } catch (err) {
        console.error('Error en build/cost:', err.message);
        return res.status(500).json({ message: 'Error al calcular coste.' });
    }
});


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
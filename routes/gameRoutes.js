const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { consumeResources } = require('../utils/resourcesService');
const { getBuildings, getBuildingLevel } = require('../utils/buildingsService');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration } = require('../utils/gameUtils'); // Importamos funciones de utilidad
const { authenticateToken } = require('../middleware/auth'); // Importamos el middleware centralizado
const entityService = require('../utils/entityService');

// -----------------------------------------------------------------
// ⭐️ CONSTANTES
// -----------------------------------------------------------------

const POPULATION_CHANGE_RATE = 1; 

const { BUILDING_COSTS } = require('../constants/buildings');
const { ALLOWED_BUILDINGS_BY_FACTION } = require('../constants/buildingFactions');

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

                // Check population availability for non-house buildings
                // Lock the entity row to avoid races when modifying population via entityService
                try {
                    await entityService.lockEntity(client, entity.id);
                } catch (e) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Entidad no encontrada.' });
                }
                // Determine faction name (if any) for permission checks
                let factionName = null;
                try {
                    const er = await entityService.getEntityById(client, entity.id, false);
                    const fid = er && er.faction_id;
                    if (fid) {
                        const fnr = await client.query('SELECT name FROM factions WHERE id = $1 LIMIT 1', [fid]);
                        if (fnr.rows.length > 0) factionName = fnr.rows[0].name;
                    }
                } catch (fErr) {
                    console.warn('Failed to load faction name for permission check:', fErr.message);
                }

                // Check faction-based building permissions
                if (factionName && ALLOWED_BUILDINGS_BY_FACTION && Object.keys(ALLOWED_BUILDINGS_BY_FACTION).length > 0) {
                    const allowedList = ALLOWED_BUILDINGS_BY_FACTION[factionName];
                    if (Array.isArray(allowedList) && !allowedList.includes(buildingType)) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            message: `La facción '${factionName}' no está permitida para construir '${buildingType}'.`,
                            code: 'NOT_ALLOWED_FOR_FACTION',
                            allowed: false,
                            faction: factionName,
                            buildingType
                        });
                    }
                }
                // In this project `max_population` is the capacity and
                // `current_population` is the available (free) population.
                const populationService = require('../utils/populationService');
                // Use centralized helper inside the transaction to compute occupation/available
                const popCalc = await populationService.calculateAvailablePopulationWithClient(client, entity.id);
                const currPop = popCalc.total || 0;
                const maxPop = popCalc.max || 0;

                // Determine per-building population need
                const popNeeded = BUILDING_COSTS[buildingType] && typeof BUILDING_COSTS[buildingType].popNeeded === 'number' ? BUILDING_COSTS[buildingType].popNeeded : (buildingType === 'house' ? 0 : 1);
                if ((popNeeded || 0) > 0) {
                    const available = popCalc.available || 0;
                    if (available < popNeeded) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({
                            message: 'Población insuficiente para asignar al edificio.',
                            code: 'INSUFFICIENT_POPULATION',
                            need: popNeeded,
                            have: available
                        });
                    }
                }

        // Consume resources within this same transaction
        try {
            // Debug: log current resources before attempting to consume
            try {
                // Read current resources via resourcesService for logging
                const resourcesService = require('../utils/resourcesService');
                const curObj = await resourcesService.getResourcesWithClient(client, entity.id);
                console.log(`Current resources for entity ${entity.id}:`, curObj);
            } catch (logErr) {
                console.warn('Failed to read current resources for logging:', logErr.message);
            }
            // Use generic consume when building cost uses arbitrary resource keys
            const resourcesService = require('../utils/resourcesService');
            // Map cost object to include only keys with positive amounts
            const costToUse = Object.fromEntries(Object.entries(cost).filter(([k,v]) => Number(v) > 0));
            // If cost contains keys other than wood/stone/food, use generic consumer
            const nonStandard = Object.keys(costToUse).some(k => !['wood','stone','food'].includes(k));
            if (nonStandard) {
                await resourcesService.consumeResourcesWithClientGeneric(client, entity.id, costToUse);
            } else {
                await resourcesService.consumeResourcesWithClient(client, entity.id, costToUse);
            }
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

        // 5️⃣ Incrementar nivel o crear edificio (centralizado)
        const { incrementBuildingLevelWithClient } = require('../utils/buildingsService');
        await incrementBuildingLevelWithClient(client, entity.id, buildingType);

        // 5️⃣ Obtener edificios actualizados
        const updatedBuildings = await getBuildings(entity.id);


        // If the building consumes population, decrement one unit from the 'poor' bucket by default
        if (buildingType !== 'house') {
            // Decrement one unit from poor bucket and compute available centralised
            await populationService.setPopulationForTypeComputedWithClient(client, entity.id, 'poor', Math.max(0, currPop - 1), maxPop);
        }

        // If new building is one of the special houses, increase the appropriate population max bucket
        try {
            if (buildingType === 'casa_de_piedra') {
                const gu = require('../utils/gameUtils');
                const inc = gu.POPULATION_PER_HOUSE || 5;
                const prow = await populationService.getPopulationByTypeWithClient(client, entity.id, 'burgess');
                const cur = Number(prow.current || 0);
                const maxv = Number(prow.max || 0) + inc;
                const avail = Math.max(0, maxv - cur);
                await populationService.setPopulationForTypeWithClient(client, entity.id, 'burgess', cur, maxv, avail);
            } else if (buildingType === 'casa_de_ladrillos') {
                const gu = require('../utils/gameUtils');
                const inc = gu.POPULATION_PER_HOUSE || 5;
                const prow = await populationService.getPopulationByTypeWithClient(client, entity.id, 'patrician');
                const cur = Number(prow.current || 0);
                const maxv = Number(prow.max || 0) + inc;
                const avail = Math.max(0, maxv - cur);
                await populationService.setPopulationForTypeWithClient(client, entity.id, 'patrician', cur, maxv, avail);
            }
        } catch (e) {
            console.warn('Failed to update special house population buckets:', e.message);
        }

    // 6️⃣ Obtener entidad actualizada (población, recursos) via entityService
    const updatedEntity = await entityService.getEntityById(client, entity.id, false);

        // Obtener recursos actualizados via resourcesService
        const updatedResources = await require('../utils/resourcesService').getResourcesWithClient(client, entity.id);

        // If the building consumes population, increment back (release) one unit to 'poor' bucket
        if (buildingType !== 'house') {
            // Recompute using centralized helper to get latest occupation/available and breakdown
            const newCalc = await populationService.calculateAvailablePopulationWithClient(client, entity.id);
            const newBreak = newCalc.breakdown || {};
            const newMax = newCalc.max || 0;
            await populationService.setPopulationForTypeComputedWithClient(client, entity.id, 'poor', Math.min(newMax, (newBreak.poor || 0) + 1), newMax);
        }
        // If the built building is a house, increase poor.max_population
        if (buildingType === 'house') {
            try {
                const gu = require('../utils/gameUtils');
                const inc = gu.POPULATION_PER_HOUSE || 5;
                const prow = await populationService.getPopulationByTypeWithClient(client, entity.id, 'poor');
                const cur = Number(prow.current || 0);
                const maxv = Number(prow.max || 0) + inc;
                await populationService.setPopulationForTypeComputedWithClient(client, entity.id, 'poor', cur, maxv);
            } catch (e) {
                console.warn('Failed to update house population bucket (poor):', e.message);
            }
        }

        // recompute popSummary for response (centralized helper) inside the transaction
        const finalPopSummary = await populationService.calculateAvailablePopulationWithClient(client, entity.id);

        await client.query('COMMIT');

        // 7️⃣ Enviar respuesta completa al frontend
        res.status(200).json({
            message: `Construcción de ${buildingType} completada.`,
            entity: {
                id: updatedEntity.id,
                faction_id: updatedEntity.faction_id,
                x_coord: updatedEntity.x_coord,
                y_coord: updatedEntity.y_coord,
                current_population: finalPopSummary.total,
                max_population: finalPopSummary.max,
                resources: updatedResources
            },
            buildings: updatedBuildings.rows,
            population: {
                current_population: finalPopSummary.total,
                max_population: finalPopSummary.max,
                available_population: finalPopSummary.available
            }
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
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
    const ent = await entityService.getEntityByUserId(pool, userId);
    if (!ent) return res.status(404).json({ message: 'No se encontró entidad asociada al usuario.' });
    const entityId = ent.id;

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
                const ent = await require('../utils/entityService').getEntityByUserId(pool, userId);
                if (!ent) return res.status(404).json({ message: 'No se encontró entidad para el usuario.' });
                targetEntityId = ent.id;
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

        // Determine population requirement for this building
        const popNeeded = typeof costBase.popNeeded === 'number' ? costBase.popNeeded : (buildingType === 'house' ? 0 : 1);
        // Compute available population for the target entity
        const populationService = require('../utils/populationService');
        let popInfo = { entityId: targetEntityId, current: 0, occupation: 0, available: 0 };
        try {
            // Use a short-lived client to compute availability
            const client = await pool.connect();
            try {
                popInfo = await populationService.calculateAvailablePopulationWithClient(client, targetEntityId);
            } finally {
                client.release();
            }
        } catch (e) {
            console.warn('Failed to compute population availability for build/cost:', e.message);
        }

        // Determine faction and whether this building is allowed
        let factionName = null;
        try {
            try {
                const er = await require('../utils/entityService').getEntityById(pool, targetEntityId, false);
                if (er && er.faction_id) {
                    const fnr = await pool.query('SELECT name FROM factions WHERE id = $1 LIMIT 1', [er.faction_id]);
                    if (fnr.rows.length > 0) factionName = fnr.rows[0].name;
                }
            } catch (e) {
                console.warn('Failed to load faction for cost check:', e.message);
            }
        } catch (fErr) {
            console.warn('Failed to load faction for cost check:', fErr.message);
        }

        let allowed = true;
        if (factionName && ALLOWED_BUILDINGS_BY_FACTION && Object.keys(ALLOWED_BUILDINGS_BY_FACTION).length > 0) {
            const allowedList = ALLOWED_BUILDINGS_BY_FACTION[factionName];
            if (Array.isArray(allowedList)) allowed = allowedList.includes(buildingType);
        }

    // Include population requirement and availability in response
    return res.status(200).json({ buildingType, entityId: targetEntityId, cost, resources, canBuild, allowed, faction: factionName, popNeeded, popAvailable: popInfo.available, popCurrent: popInfo.current, popOccupation: popInfo.occupation });
    } catch (err) {
        console.error('Error en build/cost:', err.message);
        return res.status(500).json({ message: 'Error al calcular coste.' });
    }
});


router.get('/map', authenticateToken, async (req, res) => {
    try {
        const rows = await require('../utils/entityService').listEntitiesForMap(pool);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error al obtener mapa:', err.message);
        res.status(500).json({ message: 'Error al obtener mapa.' });
    }
});

module.exports = router;
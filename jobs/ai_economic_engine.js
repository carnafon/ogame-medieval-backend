/**
 * ai_economic_engine.js
 * * Motor principal que debe ser ejecutado periódicamente (e.g., cada 1 minuto) 
 * * mediante un cron job para simular la actividad de las ciudades IA.
 */

// Usamos require() para importar la configuración de la carpeta utils
const { calculateUpgradeRequirements, BUILDING_CONFIG } = require('../utils/ai_building_config');
const aiCityService = require('../utils/ai_city_service');
const { getBuildings, getBuildingLevel } = require('../utils/buildingsService');
const pool = require('../db');

/**
 * Procesa la lógica económica (construcción, producción, comercio) para todas las ciudades IA.
 * @param {object} pool - Instancia de la conexión a PostgreSQL (pg.Pool).
 */
async function runEconomicUpdate(pool) {
    try {
        console.log(`[AI Engine] Iniciando actualización económica de ciudades IA.`);
        // 1. Obtener todas las ciudades IA (lista mínima)
        const aiCities = await aiCityService.listCities(pool, false);
        const now = new Date();

        for (const ai of aiCities) {
            // For each AI city, lock the linked entity row and operate on entities.ai_runtime
            const entRes = await pool.query('SELECT entity_id FROM ai_cities WHERE id = $1', [ai.id]);
            if (entRes.rows.length === 0 || !entRes.rows[0].entity_id) continue;
            const entityId = entRes.rows[0].entity_id;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const eRowRes = await client.query('SELECT id, ai_runtime FROM entities WHERE id = $1 FOR UPDATE', [entityId]);
                if (eRowRes.rows.length === 0) { await client.query('COMMIT'); client.release(); continue; }
                const entityRow = eRowRes.rows[0];
                const runtime = entityRow.ai_runtime || {};

                if (runtime.current_construction && new Date(runtime.current_construction.finish_time) <= now) {
                    await completeConstruction(client, ai, entityRow);
                } else {
                    // decide new construction if not building
                    if (!runtime.current_construction) {
                        await decideNewConstruction(client, ai, entityRow);
                    }
                }

                await client.query('COMMIT');
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
                console.error('[AI Engine] Error processing AI city', ai.id, err.message);
            } finally {
                client.release();
            }
        }

        console.log(`[AI Engine] Actualización económica finalizada con éxito.`);
    } catch (err) {
        console.error('[AI Engine] Error crítico en runEconomicUpdate:', err.message);
    }
}

/**
 * Run the economic update for a single AI city (useful for testing / admin triggers).
 * This function will lock the city row and perform the same update logic as the batch runner
 */
async function runEconomicUpdateForCity(pool, cityId) {
    // Find map_entities entries for this ai city and run update on each
    const mapsRes = await pool.query('SELECT id FROM map_entities WHERE ai_city_id = $1', [cityId]);
    if (mapsRes.rows.length === 0) throw new Error(`No map entries for AI City ${cityId}`);
    const now = new Date();
    for (const m of mapsRes.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const mapRowRes = await client.query('SELECT * FROM map_entities WHERE id = $1 FOR UPDATE', [m.id]);
            if (mapRowRes.rows.length === 0) { await client.query('COMMIT'); client.release(); continue; }
            const mapRow = mapRowRes.rows[0];
            const runtime = mapRow.runtime || {};

            if (runtime.current_construction && new Date(runtime.current_construction.finish_time) <= now) {
                await completeConstruction(client, { id: cityId }, mapRow);
            } else {
                // re-read runtime and decide
                const fresh = await client.query('SELECT runtime FROM map_entities WHERE id = $1', [mapRow.id]);
                const currentRuntime = (fresh.rows[0] && fresh.rows[0].runtime) || runtime;
                if (!currentRuntime.current_construction) {
                    await decideNewConstruction(client, { id: cityId }, mapRow);
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
            throw err;
        } finally {
            client.release();
        }
    }
    return true;
}

async function createCityIA(poolOrClient, cityData) {
    return await aiCityService.createCity(poolOrClient, cityData);
}

async function listCitiesIA(poolOrClient) {
    return await aiCityService.listCities(poolOrClient, false);
}


/**
 * Completa la construcción pendiente de un edificio.
 */
async function completeConstruction(client, ai, entityRow) {
    const runtime = entityRow.ai_runtime || {};
    const cc = runtime.current_construction;
    if (!cc) return;
    const { building_id, level_to_upgrade } = cc;
    const reqs = calculateUpgradeRequirements(building_id, level_to_upgrade - 1);
    if (!reqs) return;

    const popDelta = reqs.popForNextLevel - reqs.currentPopRequirement;

    // 1. Persist building level in buildings table (use client)
    const blRes = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityRow.id, building_id]);
    if (blRes.rows.length > 0) {
        await client.query('UPDATE buildings SET level = $1 WHERE entity_id = $2 AND type = $3', [level_to_upgrade, entityRow.id, building_id]);
    } else {
        await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,$3)', [entityRow.id, building_id, level_to_upgrade]);
    }

    // 2. Update runtime inside entities.ai_runtime
    const newBuildings = Object.assign({}, runtime.buildings || {});
    newBuildings[building_id] = level_to_upgrade;
    const newPopConsumed = (runtime.pop_consumed || 0) + popDelta;
    const newRuntime = Object.assign({}, runtime, { buildings: newBuildings, pop_consumed: newPopConsumed, current_construction: null });
    await client.query('UPDATE entities SET ai_runtime = $1 WHERE id = $2', [newRuntime, entityRow.id]);

    console.log(`[AI Engine] ✅ Construcción finalizada en entity ${entityRow.id}: ${building_id} Nivel ${level_to_upgrade}.`);
}


/**
 * Decide e inicia una nueva construcción basada en las necesidades de la ciudad.
 */
async function decideNewConstruction(client, ai, entityRow) {
    const runtime = entityRow.ai_runtime || {};
    // choose building with lowest level
    let bestUpgrade = null;
    let lowestLevel = Infinity;
    for (const buildingId in BUILDING_CONFIG) {
        const currentLevel = (runtime.buildings && runtime.buildings[buildingId]) || 0;
        if (currentLevel < lowestLevel) {
            lowestLevel = currentLevel;
            bestUpgrade = buildingId;
        }
    }
    if (!bestUpgrade) return;

    const currentLevel = (runtime.buildings && runtime.buildings[bestUpgrade]) || 0;
    const reqs = calculateUpgradeRequirements(bestUpgrade, currentLevel);
    if (!reqs) return;

    const availablePop = (runtime.population || 0) - (runtime.pop_consumed || 0);
    const popRequiredDelta = reqs.popForNextLevel - reqs.currentPopRequirement;
    if (availablePop < popRequiredDelta) {
        console.log(`[AI Engine] ⚠️ map_entity ${mapRow.id} necesita más población para mejorar ${bestUpgrade}.`);
        return;
    }

    // Check resources by locking resource_inventory rows for this entity
    const rows = await client.query(
        `SELECT rt.name, ri.amount
         FROM resource_inventory ri
         JOIN resource_types rt ON ri.resource_type_id = rt.id
         WHERE ri.entity_id = $1
         FOR UPDATE`,
        [mapRow.entity_id]
    );
    const currentResources = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));

    let hasEnough = true;
    for (const resource in reqs.requiredCost) {
        if ((currentResources[resource] || 0) < reqs.requiredCost[resource]) { hasEnough = false; break; }
    }

    if (!hasEnough) {
        console.log(`[AI Engine] ❌ map_entity ${mapRow.id} no tiene recursos suficientes para ${bestUpgrade}.`);
        return;
    }

    // Deduct resources
    for (const resource in reqs.requiredCost) {
        const amount = reqs.requiredCost[resource] || 0;
        if (amount <= 0) continue;
        await client.query(
            `UPDATE resource_inventory ri SET amount = amount - $1 WHERE ri.entity_id = $2 AND ri.resource_type_id = (SELECT id FROM resource_types WHERE name = $3)`,
            [amount, entityRow.id, resource]
        );
        currentResources[resource] = (currentResources[resource] || 0) - amount;
    }

    // Create construction schedule and persist to entities.ai_runtime
    const finishTime = new Date(new Date().getTime() + reqs.requiredTimeS * 1000);
    const newConstruction = { building_id: bestUpgrade, level_to_upgrade: reqs.nextLevel, finish_time: finishTime.toISOString() };

    const newRuntime = Object.assign({}, runtime, { current_construction: newConstruction, resources: currentResources });
    await client.query('UPDATE entities SET ai_runtime = $1 WHERE id = $2', [newRuntime, entityRow.id]);

    console.log(`[AI Engine] 🛠️ entity ${entityRow.id} inició construcción ${bestUpgrade} Nivel ${reqs.nextLevel}.`);
}


// Exportar la función para que el script de cron pueda llamarla
module.exports = { runEconomicUpdate };

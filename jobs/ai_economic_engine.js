/**
 * ai_economic_engine.js
 * * Motor principal que debe ser ejecutado periódicamente (e.g., cada 1 minuto) 
 * * mediante un cron job para simular la actividad de las ciudades IA.
 */

// Usamos require() para importar la configuración de edificios usada por jugadores
const { calculateUpgradeRequirements } = require('../utils/ai_building_config');
const { BUILDING_COSTS } = require('../constants/buildings');
const aiCityService = require('../utils/ai_city_service');
const { getBuildings, getBuildingLevel } = require('../utils/buildingsService');
const pool = require('../db');
const { calculateProductionForDuration, TICK_SECONDS } = require('../utils/gameUtils');
const resourcesService = require('../utils/resourcesService');
const populationService = require('../utils/populationService');

// Helper: compute upgrade requirements using BUILDING_COSTS same as the game routes
function calculateUpgradeRequirementsFromConstants(buildingType, currentLevel) {
    const costBase = BUILDING_COSTS[buildingType];
    if (!costBase) return null;
    const factor = 1.7;
    const nextLevel = currentLevel + 1;
    const requiredCost = {
        wood: Math.ceil((costBase.wood || 0) * Math.pow(nextLevel, factor)),
        stone: Math.ceil((costBase.stone || 0) * Math.pow(nextLevel, factor)),
        food: Math.ceil((costBase.food || 0) * Math.pow(nextLevel, factor)),
    };
    // population requirements: prefer explicit popNeeded if present
    const popNeeded = typeof costBase.popNeeded === 'number' ? costBase.popNeeded : (buildingType === 'house' ? 0 : 1);
    return {
        nextLevel,
        requiredCost,
        requiredTimeS: 0,
        popForNextLevel: popNeeded,
        currentPopRequirement: 0
    };
}

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
            // For each AI city, find linked entity id and operate directly on resource_inventory and buildings.
            const entRes = await pool.query('SELECT entity_id FROM ai_cities WHERE id = $1', [ai.id]);
            if (entRes.rows.length === 0 || !entRes.rows[0].entity_id) continue;
            const entityId = entRes.rows[0].entity_id;
            console.log(`[AI Engine] --- Processing AI city id=${ai.id} -> entity=${entityId}`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Compute production based on buildings and persist produced amounts to resource_inventory
                try {
                    const buildings = await getBuildings(entityId);
                    // Load population from populations table (lock rows first)
                    await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [entityId]);
                    const populationService = require('../utils/populationService');
                    const popSummary = await populationService.getPopulationSummaryWithClient(client, entityId);
                    const popStats = { current_population: popSummary.total || 0 };
                    const produced = calculateProductionForDuration(buildings, popStats, TICK_SECONDS);
                    if (produced && Object.keys(produced).length > 0) {
                        console.log(`[AI Engine] entity=${entityId} produced:`, produced);
                        await resourcesService.setResourcesWithClientGeneric(client, entityId, produced);
                        // update the entities.last_resource_update timestamp so other systems can inspect it
                        await client.query('UPDATE entities SET last_resource_update = $1 WHERE id = $2', [now.toISOString(), entityId]);
                    } else {
                        console.log(`[AI Engine] entity=${entityId} produced nothing this tick.`);
                    }
                } catch (prodErr) {
                    console.warn('[AI Engine] Error processing production for entity', entityId, prodErr.message);
                }

                // Decide a construction: pick cheapest/lowest-level building and, if resources & population available, build it immediately
                try {
                    // load building levels
                    const curBuildings = await getBuildings(entityId);
                    const runtimeBuildings = {};
                    curBuildings.forEach(b => { runtimeBuildings[b.type] = b.level || 0; });

                    // choose building with lowest level using the same building list as normal players
                    let bestUpgrade = null;
                    let lowestLevel = Infinity;
                    for (const buildingId of Object.keys(BUILDING_COSTS)) {
                        const currentLevel = runtimeBuildings[buildingId] || 0;
                        if (currentLevel < lowestLevel) {
                            lowestLevel = currentLevel;
                            bestUpgrade = buildingId;
                        }
                    }
                    if (bestUpgrade) {
                        console.log(`[AI Engine] entity=${entityId} considering building ${bestUpgrade} (current lvl ${lowestLevel})`);
                        const reqs = calculateUpgradeRequirementsFromConstants(bestUpgrade, lowestLevel);
                        console.log(`[AI Engine] entity=${entityId} build reqs for ${bestUpgrade}:`, reqs);
                        if (reqs) {
                            // check population (lock populations and read summary) using centralized helper
                            await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [entityId]);
                            const calc = await populationService.calculateAvailablePopulationWithClient(client, entityId);
                            const availablePop = calc.total || 0;
                            const popNeeded = (reqs.popForNextLevel || 0) - (reqs.currentPopRequirement || 0);
                            if (availablePop >= popNeeded) {
                                console.log(`[AI Engine] entity=${entityId} has available pop ${availablePop} and needs ${popNeeded} for ${bestUpgrade}`);
                                // lock and read resource_inventory
                                const rows = await client.query(
                                    `SELECT rt.name, ri.amount
                                     FROM resource_inventory ri
                                     JOIN resource_types rt ON ri.resource_type_id = rt.id
                                     WHERE ri.entity_id = $1
                                     FOR UPDATE`,
                                    [entityId]
                                );
                                const currentResources = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
                                console.log(`[AI Engine] entity=${entityId} current resources:`, currentResources);

                                let hasEnough = true;
                                const missing = {};
                                for (const resource in reqs.requiredCost) {
                                    const needAmt = reqs.requiredCost[resource] || 0;
                                    const haveAmt = currentResources[resource] || 0;
                                    if (haveAmt < needAmt) { hasEnough = false; missing[resource] = { need: needAmt, have: haveAmt }; }
                                }

                                if (!hasEnough) {
                                    console.log(`[AI Engine] entity=${entityId} lacks resources for ${bestUpgrade}:`, missing);
                                }

                                if (hasEnough) {
                                    console.log(`[AI Engine] entity=${entityId} has enough resources for ${bestUpgrade}`);
                                    // Deduct resources
                                    for (const resource in reqs.requiredCost) {
                                        const amount = reqs.requiredCost[resource] || 0;
                                        if (amount <= 0) continue;
                                        await client.query(
                                            `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name = $3)`,
                                            [amount, entityId, resource]
                                        );
                                    }

                                    // Persist building level increment
                                    const blRes = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, bestUpgrade]);
                                    if (blRes.rows.length > 0) {
                                        await client.query('UPDATE buildings SET level = level + 1 WHERE entity_id = $1 AND type = $2', [entityId, bestUpgrade]);
                                    } else {
                                        await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,1)', [entityId, bestUpgrade]);
                                    }

                                    console.log(`[AI Engine] entity ${entityId} built ${bestUpgrade} level ${lowestLevel + 1}`);
                                }
                            }
                        }
                    }
                } catch (buildErr) {
                    console.warn('[AI Engine] Error deciding/performing construction for entity', entityId, buildErr.message);
                }

                // --- TRADING PHASE: attempt light-weight trades with nearby AI cities to balance resources
                try {
                    // find nearby AI city entities (excluding self)
                    // findNearbyAICities: return ALL other cityIA entities on the map (search entire map)
                    async function findNearbyAICities(client, _x, _y, radius = 0, limit = 0) {
                        // Return all cityIA entities except self. Limit is optional.
                        const q = limit && limit > 0 ? `SELECT e.id, e.x_coord, e.y_coord FROM entities e WHERE e.type = 'cityIA' AND e.id <> $1 LIMIT $2` : `SELECT e.id, e.x_coord, e.y_coord FROM entities e WHERE e.type = 'cityIA' AND e.id <> $1`;
                        const params = limit && limit > 0 ? [entityId, limit] : [entityId];
                        const res = await client.query(q, params);
                        return res.rows || [];
                    }

                    const marketService = require('../utils/marketService');

                    // atomic trade using existing client (mirrors /api/resources/trade)
                    async function execAtomicTradeWithClient(client, buyerId, sellerId, resourceName, pricePerUnit, qty) {
                        const rtRes = await client.query('SELECT id, lower(name) as name FROM resource_types WHERE lower(name) = $1', [resourceName.toString().toLowerCase()]);
                        if (!rtRes.rows.length) throw new Error('Unknown resource: ' + resourceName);
                        const resourceTypeId = rtRes.rows[0].id;
                        const goldRtRes = await client.query('SELECT id FROM resource_types WHERE lower(name) = $1', ['gold']);
                        if (!goldRtRes.rows.length) throw new Error('Gold resource type missing');
                        const goldTypeId = goldRtRes.rows[0].id;

                        const idsToLock = [buyerId, sellerId].map(id => parseInt(id, 10)).sort((a, b) => a - b);
                        for (const eid of idsToLock) {
                            await client.query(`SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`, [eid]);
                        }

                        const invRes = await client.query(
                            `SELECT ri.entity_id, rt.id as resource_type_id, lower(rt.name) as name, ri.amount
                             FROM resource_inventory ri
                             JOIN resource_types rt ON ri.resource_type_id = rt.id
                             WHERE ri.entity_id = ANY($1::int[]) AND (rt.id = $2 OR rt.id = $3)`,
                            [[buyerId, sellerId], resourceTypeId, goldTypeId]
                        );

                        const byEntity = {};
                        for (const row of invRes.rows) {
                            const eid = String(row.entity_id);
                            if (!byEntity[eid]) byEntity[eid] = {};
                            byEntity[eid][row.name] = parseInt(row.amount, 10);
                        }

                        const buyerInv = byEntity[String(buyerId)] || {};
                        const sellerInv = byEntity[String(sellerId)] || {};

                        const buyerGold = buyerInv['gold'] || 0;
                        const sellerResource = sellerInv[resourceName.toString().toLowerCase()] || 0;

                        const totalCost = Number(pricePerUnit) * qty;
                        if (buyerGold < totalCost) throw new Error('Buyer lacks gold');
                        if (sellerResource < qty) throw new Error('Seller lacks stock');

                        await client.query(`UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = $3`, [totalCost, buyerId, goldTypeId]);
                        await client.query(`UPDATE resource_inventory SET amount = amount + $1 WHERE entity_id = $2 AND resource_type_id = $3`, [totalCost, sellerId, goldTypeId]);

                        await client.query(`UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = $3`, [qty, sellerId, resourceTypeId]);
                        await client.query(`UPDATE resource_inventory SET amount = amount + $1 WHERE entity_id = $2 AND resource_type_id = $3`, [qty, buyerId, resourceTypeId]);

                        const updatedRes = await client.query(
                            `SELECT ri.entity_id, rt.name, ri.amount
                             FROM resource_inventory ri
                             JOIN resource_types rt ON ri.resource_type_id = rt.id
                             WHERE ri.entity_id = ANY($1::int[])
                             ORDER BY ri.entity_id, rt.id`,
                            [[buyerId, sellerId]]
                        );
                        const snapshot = {};
                        for (const r of updatedRes.rows) {
                            const eid = String(r.entity_id);
                            if (!snapshot[eid]) snapshot[eid] = {};
                            snapshot[eid][r.name.toLowerCase()] = parseInt(r.amount, 10);
                        }
                        return snapshot;
                    }

                    // Trading heuristics
                    const RADIUS = 8;
                    const MAX_TRADES_PER_TICK = 3;
                    const BUY_LOW = 120;
                    const SELL_HIGH = 500;
                    const SAFETY_STOCK = 50;
                    const MAX_AMOUNT = 100;

                    // Load this entity coords and resources
                    const entRowRes = await client.query('SELECT x_coord, y_coord FROM entities WHERE id = $1', [entityId]);
                    const entRow = entRowRes.rows[0] || {};
                    const x = entRow.x_coord || 0;
                    const y = entRow.y_coord || 0;

                    const nearby = await findNearbyAICities(client, x, y, RADIUS, 8);
                    console.log(`[AI Engine] entity=${entityId} found ${nearby.length} potential trade partners`);
                    if ((nearby || []).length > 0) {
                        const meRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`, [entityId]);
                        const myResources = Object.fromEntries(meRes.rows.map(r => [r.name, parseInt(r.amount, 10)]));

                        let tradesDone = 0;

                        // Try to buy deficits
                        for (const [resName, curAmt] of Object.entries(myResources)) {
                            if (tradesDone >= MAX_TRADES_PER_TICK) break;
                            if (resName === 'gold') continue;
                            if (curAmt >= BUY_LOW) continue;
                            const need = Math.min(MAX_AMOUNT, BUY_LOW - curAmt);
                            for (const nb of nearby) {
                                if (tradesDone >= MAX_TRADES_PER_TICK) break;
                                try {
                                    const nRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1 AND lower(rt.name) = $2`, [nb.id, resName]);
                                    const sellerStock = (nRes.rows[0] && parseInt(nRes.rows[0].amount, 10)) || 0;
                                    console.log(`[AI Engine] Trade attempt BUY: entity=${entityId} needs ${need} of ${resName}; seller=${nb.id} stock=${sellerStock}`);
                                    if (sellerStock <= SAFETY_STOCK) continue;
                                    const availableToSell = Math.min(need, Math.max(0, sellerStock - SAFETY_STOCK));
                                    if (availableToSell <= 0) continue;
                                    const mp = await marketService.computeMarketPriceSingle(client, resName, availableToSell, 'buy');
                                    if (!mp) {
                                        console.log(`[AI Engine] computeMarketPriceSingle returned null for ${resName}`);
                                        continue;
                                    }
                                    const qty = Math.min(availableToSell, MAX_AMOUNT);
                                    try {
                                        await marketService.tradeWithClient(client, entityId, nb.id, resName, mp.price, qty);
                                        console.log(`[AI Engine][Trade] entity ${entityId} bought ${qty} ${resName} from ${nb.id} at ${mp.price} each`);
                                        tradesDone++;
                                    } catch (tradeErr) {
                                        console.warn(`[AI Engine] tradeWithClient failed (buy) entity=${entityId} seller=${nb.id} res=${resName}:`, tradeErr.message);
                                    }
                                } catch (tErr) {
                                    console.warn('[AI Engine] trade loop error (buy):', tErr.message);
                                }
                            }
                        }

                        // Try to sell surpluses
                        if (tradesDone < MAX_TRADES_PER_TICK) {
                            for (const [resName, curAmt] of Object.entries(myResources)) {
                                if (tradesDone >= MAX_TRADES_PER_TICK) break;
                                if (resName === 'gold') continue;
                                if (curAmt <= SELL_HIGH) continue;
                                const surplus = curAmt - SELL_HIGH;
                                for (const nb of nearby) {
                                    if (tradesDone >= MAX_TRADES_PER_TICK) break;
                                    try {
                                        const nRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1 AND lower(rt.name) = $2`, [nb.id, resName]);
                                        const neighborAmt = (nRes.rows[0] && parseInt(nRes.rows[0].amount, 10)) || 0;
                                        console.log(`[AI Engine] Trade attempt SELL: entity=${entityId} has surplus=${surplus} of ${resName}; neighbor=${nb.id} amt=${neighborAmt}`);
                                        if (neighborAmt >= BUY_LOW) continue;
                                        const wanted = Math.min(MAX_AMOUNT, BUY_LOW - neighborAmt);
                                        const toSell = Math.min(surplus, wanted);
                                        if (toSell <= 0) continue;
                                        const mp = await marketService.computeMarketPriceSingle(client, resName, toSell, 'sell');
                                        if (!mp) continue;
                                        try {
                                            await marketService.tradeWithClient(client, nb.id, entityId, resName, mp.price, toSell);
                                            console.log(`[AI Engine][Trade] entity ${entityId} sold ${toSell} ${resName} to ${nb.id} at ${mp.price} each`);
                                            tradesDone++;
                                        } catch (tradeErr) {
                                            console.warn(`[AI Engine] tradeWithClient failed (sell) entity=${entityId} buyer=${nb.id} res=${resName}:`, tradeErr.message);
                                        }
                                    } catch (tErr) {
                                        console.warn('[AI Engine] trade loop error (sell):', tErr.message);
                                    }
                                }
                            }
                        }
                        console.log(`[AI Engine] entity=${entityId} trading summary: tradesDone=${tradesDone}`);
                    }
                } catch (tradeErr) {
                    console.warn('[AI Engine] Error during trading phase for entity', entityId, tradeErr.message);
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
    // Find the linked entity for this AI city and run the update on that entity.
    const entRes = await pool.query('SELECT entity_id FROM ai_cities WHERE id = $1', [cityId]);
    if (entRes.rows.length === 0 || !entRes.rows[0].entity_id) throw new Error(`No entity linked to AI City ${cityId}`);
    const entityId = entRes.rows[0].entity_id;
    const now = new Date();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const entityRowRes = await client.query('SELECT * FROM entities WHERE id = $1 FOR UPDATE', [entityId]);
        if (entityRowRes.rows.length === 0) { await client.query('COMMIT'); return true; }
        const entityRow = entityRowRes.rows[0];
        const runtime = entityRow.ai_runtime || {};

        if (runtime.current_construction && new Date(runtime.current_construction.finish_time) <= now) {
            await completeConstruction(client, { id: cityId }, entityRow);
        } else {
            // re-read runtime from entities and decide
            const fresh = await client.query('SELECT ai_runtime as runtime FROM entities WHERE id = $1', [entityRow.id]);
            const currentRuntime = (fresh.rows[0] && fresh.rows[0].runtime) || runtime;
            if (!currentRuntime.current_construction) {
                await decideNewConstruction(client, { id: cityId }, entityRow);
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        throw err;
    } finally {
        client.release();
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
    const reqs = calculateUpgradeRequirementsFromConstants(building_id, level_to_upgrade - 1);
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
    const reqs = calculateUpgradeRequirementsFromConstants(bestUpgrade, currentLevel);
    if (!reqs) return;

    const availablePop = (runtime.population || 0) - (runtime.pop_consumed || 0);
    const popRequiredDelta = reqs.popForNextLevel - reqs.currentPopRequirement;
    if (availablePop < popRequiredDelta) {
        console.log(`[AI Engine] ⚠️ entity ${entityRow.id} necesita más población para mejorar ${bestUpgrade}.`);
        return;
    }

    // Check resources by locking resource_inventory rows for this entity
    const rows = await client.query(
        `SELECT rt.name, ri.amount
         FROM resource_inventory ri
         JOIN resource_types rt ON ri.resource_type_id = rt.id
         WHERE ri.entity_id = $1
         FOR UPDATE`,
        [entityRow.id]
    );
    const currentResources = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));

    let hasEnough = true;
    for (const resource in reqs.requiredCost) {
        if ((currentResources[resource] || 0) < reqs.requiredCost[resource]) { hasEnough = false; break; }
    }

    if (!hasEnough) {
        console.log(`[AI Engine] ❌ entity ${entityRow.id} no tiene recursos suficientes para ${bestUpgrade}.`);
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

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

// Dynamic producer lookup using PRODUCTION_RATES in gameUtils
const gameUtils = require('../utils/gameUtils');
function findProducerForResource(resourceName) {
    if (!resourceName) return null;
    const key = resourceName.toString().toLowerCase();
    const prodRates = gameUtils.PRODUCTION_RATES || {};
    // Search for a building that has a positive production rate for this resource
    for (const [building, rates] of Object.entries(prodRates)) {
        if (rates && Object.prototype.hasOwnProperty.call(rates, key) && Number(rates[key]) > 0) return building;
    }
    // fallback: try some well-known mappings
    const FALLBACK = { wood: 'sawmill', stone: 'quarry', food: 'farm', lumber: 'carpinteria', baked_brick: 'fabrica_ladrillos', linen: 'lineria' };
    return FALLBACK[key] || null;
}

// Map a building type to which population bucket it consumes: 'poor'|'burgess'|'patrician'
function mapBuildingToPopulationBucket(buildingType) {
    if (!buildingType) return 'poor';
    const key = buildingType.toString().toLowerCase();
    const prodRates = gameUtils.PRODUCTION_RATES || {};
    const resourceCategories = gameUtils.RESOURCE_CATEGORIES || {};
    const rates = prodRates[key] || {};
    for (const res of Object.keys(rates)) {
        const cat = resourceCategories[res];
        if (!cat) continue;
        if (cat === 'common') return 'poor';
        if (cat === 'processed') return 'burgess';
        if (cat === 'specialized') return 'patrician';
    }
    // fallback heuristics by name
    if (key.includes('farm') || key.includes('well') || key.includes('sawmill') || key.includes('quarry')) return 'poor';
    if (key.includes('carpinter') || key.includes('fabrica') || key.includes('alfareria') || key.includes('tintoreria')) return 'burgess';
    return 'poor';
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

            const random = Math.random();
            //Sacamos un random para ver si procesamos esta ciudad o no. Si sale menos de 0.3, la procesamos.
            if (random < 0.3) {
                console.log(`[AI Engine] Processing entity=${entityId} (random=${random.toFixed(3)})`);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Load resource price_base map once for heuristics (used by build and trade phases)
                const ptAllTop = await client.query('SELECT lower(name) as name, price_base FROM resource_types');
                const priceBaseMapTop = {};
                for (const r of ptAllTop.rows) priceBaseMapTop[r.name] = Number(r.price_base) || 1;

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
                        console.log(`[AI Engine] entity=${entityId} produced (deltas):`, produced);
                        // Lock resource rows and read current inventory via resourcesService
                        await resourcesService.lockResourceRowsWithClient(client, entityId);
                        const before = await resourcesService.getResourcesWithClient(client, entityId);
                        const toWrite = {};
                        Object.keys(produced).forEach(k => {
                            const key = k.toString().toLowerCase();
                            const delta = Number(produced[k]) || 0;
                            const have = Number(before[key] || 0);
                            toWrite[key] = Math.max(0, have + delta);
                        });
                        console.log(`[AI Engine] entity=${entityId} resource before:`, before, 'toWrite (after applying deltas):', toWrite);
                        await resourcesService.setResourcesWithClientGeneric(client, entityId, toWrite);
                        // update the entities.last_resource_update timestamp so other systems can inspect it
                        await client.query('UPDATE entities SET last_resource_update = $1 WHERE id = $2', [now.toISOString(), entityId]);
                        // log after snapshot via resourcesService
                        const after = await resourcesService.getResourcesWithClient(client, entityId);
                        console.log(`[AI Engine] entity=${entityId} resource after:`, after);
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

                    // choose building using a heuristic: prefer low-level AND buildings that produce high-value resources
                    let bestUpgrade = null;
                    let bestScore = Infinity; // lower score is better

                    // Load current resources (light read, no FOR UPDATE) to let AI prefer food buildings when starving
                    // light read of resources
                    let currentResourcesLight = {};
                    try {
                        const all = await resourcesService.getResourcesWithClient(client, entityId);
                        currentResourcesLight = { wood: all.wood || 0, stone: all.stone || 0, food: all.food || 0 };
                    } catch (e) { currentResourcesLight = {}; }

                    // If production for food this tick was negative or food stock is low, prefer to build a farm if present
                    const foodProduced = (typeof produced === 'object' && typeof produced.food === 'number') ? produced.food : 0;
                    const FOOD_LOW_THRESHOLD = 20;
                    if ((foodProduced < 0 || (currentResourcesLight.food || 0) < FOOD_LOW_THRESHOLD) && BUILDING_COSTS['farm']) {
                        bestUpgrade = 'farm';
                        lowestLevel = runtimeBuildings['farm'] || 0;
                    }

                    // Fallback: choose the globally lowest-level building
                    if (!bestUpgrade) {
                        const prodRatesAll = gameUtils.PRODUCTION_RATES || {};
                        for (const buildingId of Object.keys(BUILDING_COSTS)) {
                            const currentLevel = runtimeBuildings[buildingId] || 0;
                            // compute value produced per tick in gold-equivalent using price_base
                            const rates = prodRatesAll[buildingId] || {};
                            let valueSum = 0;
                            for (const res of Object.keys(rates)) {
                                const rate = Number(rates[res]) || 0;
                                const base = priceBaseMapTop[res] || 1;
                                valueSum += rate * base;
                            }
                            // Score: level minus scaled valueSum (prefer buildings that increase gold production)
                            const score = currentLevel - (valueSum / 10);
                            if (score < bestScore) {
                                bestScore = score;
                                bestUpgrade = buildingId;
                            }
                        }
                    }
                    if (bestUpgrade) {
                        const lowestLevel = runtimeBuildings[bestUpgrade] || 0;
                        console.log(`[AI Engine] entity=${entityId} considering building ${bestUpgrade} (current lvl ${lowestLevel})`);
                        const reqs = calculateUpgradeRequirementsFromConstants(bestUpgrade, lowestLevel);
                        console.log(`[AI Engine] entity=${entityId} build reqs for ${bestUpgrade}:`, reqs);
                        if (reqs) {
                        // lock populations and compute availability using populationService
                        await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [entityId]);
                        const calc = await populationService.calculateAvailablePopulationWithClient(client, entityId);
                            const availablePop = calc.available || 0;
                            const popNeeded = (reqs.popForNextLevel || 0) - (reqs.currentPopRequirement || 0);

                            const HOUSE_TYPES = ['house', 'casa_de_piedra', 'casa_de_ladrillos'];
                            const isHouseType = HOUSE_TYPES.includes(bestUpgrade);

                            const targetBucket = mapBuildingToPopulationBucket(bestUpgrade);
                            const currentForBucket = (calc.breakdown && Number.isFinite(Number(calc.breakdown[targetBucket])) ? Number(calc.breakdown[targetBucket]) : 0);
                            let perTypeMax = null;
                            try {
                                const prow = await populationService.getPopulationByTypeWithClient(client, entityId, targetBucket);
                                perTypeMax = Number(prow.max || 0);
                            } catch (e) { perTypeMax = null; }

                            const enoughAvailable = (availablePop >= popNeeded);
                            const atCapacity = (perTypeMax !== null && currentForBucket >= perTypeMax);

                            // If not enough available and not a house, consider building a house if at capacity
                            if (!enoughAvailable && !isHouseType) {
                                if (atCapacity) {
                                    const bucketHouse = targetBucket === 'poor' ? 'house' : (targetBucket === 'burgess' ? 'casa_de_piedra' : 'casa_de_ladrillos');
                                    const houseLevel = runtimeBuildings[bucketHouse] || 0;
                                    const houseReqs = calculateUpgradeRequirementsFromConstants(bucketHouse, houseLevel);
                                    if (houseReqs) {
                                        // quick resource check
                                        await resourcesService.lockResourceRowsWithClient(client, entityId);
                                        const currentResources = await resourcesService.getResourcesWithClient(client, entityId);
                                        let enoughForHouse = true;
                                        for (const r in houseReqs.requiredCost) {
                                            if ((currentResources[r] || 0) < houseReqs.requiredCost[r]) { enoughForHouse = false; break; }
                                        }
                                        if (enoughForHouse) {
                                            bestUpgrade = bucketHouse;
                                            reqs.requiredCost = houseReqs.requiredCost;
                                            reqs.nextLevel = houseReqs.nextLevel;
                                            reqs.popForNextLevel = houseReqs.popForNextLevel;
                                            reqs.currentPopRequirement = houseReqs.currentPopRequirement;
                                        } else {
                                            // cannot build house due to lack of resources, skip building
                                            console.log(`[AI Engine] entity=${entityId} lacks resources to build ${bucketHouse} to expand capacity.`);
                                            // exit build attempt
                                            // nothing to do here, AI will try other actions later
                                            // we just skip to next phase
                                            // (no explicit return to keep transactional context intact)
                                        }
                                    }
                                } else {
                                    // not enough available and not at capacity -> cannot build
                                    // skip build
                                }
                            }

                            // After possible house fallback, attempt resource check and build if resources suffice
                            // lock and read resource_inventory via resourcesService
                            await resourcesService.lockResourceRowsWithClient(client, entityId);
                            const currentResources = await resourcesService.getResourcesWithClient(client, entityId);

                            let hasEnough = true;
                            const missing = {};
                            for (const resource in reqs.requiredCost) {
                                const needAmt = reqs.requiredCost[resource] || 0;
                                const haveAmt = currentResources[resource] || 0;
                                if (haveAmt < needAmt) { hasEnough = false; missing[resource] = { need: needAmt, have: haveAmt }; }
                            }

                            if (!hasEnough) {
                                // Try producer fallback
                                try {
                                    const missingKeys = Object.keys(missing || {});
                                    if (missingKeys.length > 0) {
                                        const producer = findProducerForResource(missingKeys[0]);
                                        if (producer && producer !== bestUpgrade && BUILDING_COSTS[producer]) {
                                            const prodCurLevel = runtimeBuildings[producer] || 0;
                                            const prodReqs = calculateUpgradeRequirementsFromConstants(producer, prodCurLevel);
                                            if (prodReqs) {
                                                const prodPopNeeded = (prodReqs.popForNextLevel || 0) - (prodReqs.currentPopRequirement || 0);
                                                if ((calc.available || 0) >= prodPopNeeded) {
                                                    let enoughForProducer = true;
                                                    for (const r in prodReqs.requiredCost) {
                                                        if ((currentResources[r] || 0) < prodReqs.requiredCost[r]) { enoughForProducer = false; break; }
                                                    }
                                                    if (enoughForProducer) {
                                                        bestUpgrade = producer;
                                                        lowestLevel = prodCurLevel;
                                                        reqs.requiredCost = prodReqs.requiredCost;
                                                        reqs.nextLevel = prodReqs.nextLevel;
                                                        reqs.popForNextLevel = prodReqs.popForNextLevel;
                                                        reqs.currentPopRequirement = prodReqs.currentPopRequirement;
                                                        hasEnough = true;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (pe) {
                                    console.warn('[AI Engine] error while selecting producer for missing resource', pe.message);
                                }
                            }

                            if (hasEnough) {
                                // Deduct resources via resourcesService adjust helper
                                const deltas = {};
                                for (const resource in reqs.requiredCost) {
                                    const amount = reqs.requiredCost[resource] || 0;
                                    if (amount <= 0) continue;
                                    deltas[resource.toString().toLowerCase()] = -Math.abs(amount);
                                }
                                await resourcesService.adjustResourcesWithClientGeneric(client, entityId, deltas);


                                // Persist building level increment
                                const blRes = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, bestUpgrade]);
                                const { incrementBuildingLevelWithClient } = require('../utils/buildingsService');
                                await incrementBuildingLevelWithClient(client, entityId, bestUpgrade);

                                console.log(`[AI Engine] entity ${entityId} built ${bestUpgrade} level ${lowestLevel + 1}`);

                                // If house built, update population bucket max accordingly
                                    try {
                                        const gu = require('../utils/gameUtils');
                                        const inc = gu.POPULATION_PER_HOUSE || 5;
                                        if (bestUpgrade === 'casa_de_piedra') {
                                            const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'burgess');
                                            const cur = Number(prow.current || 0);
                                            const maxv = Number(prow.max || 0) + inc;
                                            const avail = Math.max(0, maxv - cur);
                                            await populationService.setPopulationForTypeWithClient(client, entityId, 'burgess', cur, maxv, avail);
                                        } else if (bestUpgrade === 'casa_de_ladrillos') {
                                            const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'patrician');
                                            const cur = Number(prow.current || 0);
                                            const maxv = Number(prow.max || 0) + inc;
                                            const avail = Math.max(0, maxv - cur);
                                            await populationService.setPopulationForTypeWithClient(client, entityId, 'patrician', cur, maxv, avail);
                                        } else if (bestUpgrade === 'house') {
                                            const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'poor');
                                            const cur = Number(prow.current || 0);
                                            const maxv = Number(prow.max || 0) + inc;
                                            const avail = Math.max(0, maxv - cur);
                                            await populationService.setPopulationForTypeWithClient(client, entityId, 'poor', cur, maxv, avail);
                                        }
                                    } catch (e) {
                                        console.warn('[AI Engine] Failed to update house population bucket:', e.message);
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
                    // We'll compute per-resource thresholds from resource_types.price_base
                    const BASE_BUY_DIV = 120;   // buy threshold = BASE_BUY_DIV / price_base
                    const BASE_SELL_DIV = 500;  // sell threshold = BASE_SELL_DIV / price_base
                    const SAFETY_STOCK = 500;
                    const MAX_AMOUNT = 100;

                    // Load price_base for all resource types (reuse mapping already loaded at top for heuristics)
                    const priceBaseMap = priceBaseMapTop;

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
                            const base = priceBaseMap[resName] || 1;
                            const buyLow = Math.max(1, Math.round(BASE_BUY_DIV / base));
                            if (curAmt >= buyLow) continue;
                            const need = Math.min(MAX_AMOUNT, buyLow - curAmt);
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

                        // Try to sell surpluses: prioritize high-value surplus resources to maximize gold
                        if (tradesDone < MAX_TRADES_PER_TICK) {
                            // build candidate list of {resName, curAmt, surplus, base, score}
                            const sellCandidates = [];
                            for (const [resName, curAmt] of Object.entries(myResources)) {
                                if (resName === 'gold') continue;
                                const base = priceBaseMap[resName] || 1;
                                const buyLow = Math.max(1, Math.round(BASE_BUY_DIV / base));
                                const sellHigh = Math.max(buyLow + 1, Math.round(BASE_SELL_DIV / base));
                                if (curAmt <= sellHigh) continue;
                                const surplus = curAmt - sellHigh;
                                // score by surplus * base (value of surplus)
                                sellCandidates.push({ resName, curAmt, surplus, base, score: surplus * base, buyLow, sellHigh });
                            }
                            // sort descending by score (high value surplus first)
                            sellCandidates.sort((a, b) => b.score - a.score);
                            for (const cand of sellCandidates) {
                                if (tradesDone >= MAX_TRADES_PER_TICK) break;
                                const { resName, surplus, buyLow } = cand;
                                for (const nb of nearby) {
                                    if (tradesDone >= MAX_TRADES_PER_TICK) break;
                                    try {
                                        const nRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1 AND lower(rt.name) = $2`, [nb.id, resName]);
                                        const neighborAmt = (nRes.rows[0] && parseInt(nRes.rows[0].amount, 10)) || 0;
                                        console.log(`[AI Engine] Trade attempt SELL: entity=${entityId} has surplus=${surplus} of ${resName}; neighbor=${nb.id} amt=${neighborAmt}`);
                                        if (neighborAmt >= buyLow) continue;
                                        const wanted = Math.min(MAX_AMOUNT, buyLow - neighborAmt);
                                        const toSell = Math.min(surplus, wanted);
                                        if (toSell <= 0) continue;
                                        const mp = await marketService.computeMarketPriceSingle(client, resName, toSell, 'sell');
                                        if (!mp) continue;
                                        // Only sell if market price is at or above base to ensure profitable sale
                                        const base = priceBaseMap[resName] || 1;
                                        if (mp.price < base) {
                                            console.log(`[AI Engine] Skipping sale of ${resName} because market price ${mp.price} < base ${base}`);
                                            continue;
                                        }
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
    const { setBuildingLevelWithClient } = require('../utils/buildingsService');
    await setBuildingLevelWithClient(client, entityRow.id, building_id, level_to_upgrade);
    } else {
        await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,$3)', [entityRow.id, building_id, level_to_upgrade]);
    }

    // 2. Update runtime inside entities.ai_runtime (we no longer track pop_consumed here; populations are persisted in populations table)
    const newBuildings = Object.assign({}, runtime.buildings || {});
    newBuildings[building_id] = level_to_upgrade;
    const newRuntime = Object.assign({}, runtime, { buildings: newBuildings, current_construction: null });
    await client.query('UPDATE entities SET ai_runtime = $1 WHERE id = $2', [newRuntime, entityRow.id]);

    // If the building completed is a house-type, update the corresponding population max bucket
    try {
        const gu = require('../utils/gameUtils');
        const inc = gu.POPULATION_PER_HOUSE || 5;
        if (building_id === 'casa_de_piedra') {
            const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityRow.id, 'burgess']);
            if (prow.rows.length > 0) {
                const cur = parseInt(prow.rows[0].current_population || 0, 10);
                const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
                const avail = Math.max(0, maxv - cur);
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'burgess', cur, maxv, avail);
            } else {
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'burgess', 0, inc, inc);
            }
        } else if (building_id === 'casa_de_ladrillos') {
            const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityRow.id, 'patrician']);
            if (prow.rows.length > 0) {
                const cur = parseInt(prow.rows[0].current_population || 0, 10);
                const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
                const avail = Math.max(0, maxv - cur);
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'patrician', cur, maxv, avail);
            } else {
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'patrician', 0, inc, inc);
            }
        } else if (building_id === 'house') {
            const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityRow.id, 'poor']);
            if (prow.rows.length > 0) {
                const cur = parseInt(prow.rows[0].current_population || 0, 10);
                const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
                const avail = Math.max(0, maxv - cur);
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'poor', cur, maxv, avail);
            } else {
                await populationService.setPopulationForTypeWithClient(client, entityRow.id, 'poor', 0, inc, inc);
            }
        }
    } catch (e) {
        console.warn('[AI Engine] Failed to update populations on construction complete:', e.message);
    }

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

    // Use centralized populations table to determine availability
    await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [entityRow.id]);
    const popCalc = await populationService.calculateAvailablePopulationWithClient(client, entityRow.id);
    const popRequiredDelta = reqs.popForNextLevel - reqs.currentPopRequirement;
    const HOUSE_TYPES = ['house', 'casa_de_piedra', 'casa_de_ladrillos'];
    const isHouseType = HOUSE_TYPES.includes(bestUpgrade);

    const availablePop = popCalc.available || 0;
    const targetBucket = mapBuildingToPopulationBucket(bestUpgrade);
    const currentForBucket = (popCalc.breakdown && Number.isFinite(Number(popCalc.breakdown[targetBucket])) ? Number(popCalc.breakdown[targetBucket]) : 0);
    let perTypeMax = null;
    try {
        const prow = await client.query('SELECT max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityRow.id, targetBucket]);
        if (prow.rows.length > 0) perTypeMax = Number(prow.rows[0].max_population || 0);
    } catch (e) { perTypeMax = null; }

    const enoughAvailable = (availablePop >= popRequiredDelta);
    const atCapacity = (perTypeMax !== null && currentForBucket >= perTypeMax);
    if (!enoughAvailable && !isHouseType) {
        if (atCapacity) {
            // Try building a house to expand capacity
            const bucketHouse = targetBucket === 'poor' ? 'house' : (targetBucket === 'burgess' ? 'casa_de_piedra' : 'casa_de_ladrillos');
            console.log(`[AI Engine] entity=${entityRow.id} at capacity on ${targetBucket}, will try to schedule ${bucketHouse} instead of ${bestUpgrade}`);
            const houseLevel = (runtime.buildings && runtime.buildings[bucketHouse]) || 0;
            const houseReqs = calculateUpgradeRequirementsFromConstants(bucketHouse, houseLevel);
            if (houseReqs) {
                // quick resource check
                const rows = await client.query(
                    `SELECT rt.name, ri.amount
                     FROM resource_inventory ri
                     JOIN resource_types rt ON ri.resource_type_id = rt.id
                     WHERE ri.entity_id = $1
                     FOR UPDATE`,
                    [entityRow.id]
                );
                const currentResources = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
                let enoughForHouse = true;
                for (const r in houseReqs.requiredCost) {
                    if ((currentResources[r] || 0) < houseReqs.requiredCost[r]) { enoughForHouse = false; break; }
                }
                if (enoughForHouse) {
                    // switch the plan to build the house
                    bestUpgrade = bucketHouse;
                    reqs.requiredCost = houseReqs.requiredCost;
                    reqs.nextLevel = houseReqs.nextLevel;
                    reqs.popForNextLevel = houseReqs.popForNextLevel;
                    reqs.currentPopRequirement = houseReqs.currentPopRequirement;
                } else {
                    console.log(`[AI Engine] entity=${entityRow.id} lacks resources to build ${bucketHouse} to expand capacity.`);
                    return;
                }
            } else {
                return;
            }
        } else {
            console.log(`[AI Engine] ⚠️ entity ${entityRow.id} necesita más población para mejorar ${bestUpgrade}.`);
            return;
        }
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

    // No reservation of current population here. Occupation is derived from buildings and will
    // automatically affect available population once the building is persisted.

    // Create construction schedule and persist to entities.ai_runtime
    const finishTime = new Date(new Date().getTime() + reqs.requiredTimeS * 1000);
    const newConstruction = { building_id: bestUpgrade, level_to_upgrade: reqs.nextLevel, finish_time: finishTime.toISOString() };

    const newRuntime = Object.assign({}, runtime, { current_construction: newConstruction, resources: currentResources });
    await client.query('UPDATE entities SET ai_runtime = $1 WHERE id = $2', [newRuntime, entityRow.id]);

    console.log(`[AI Engine] 🛠️ entity ${entityRow.id} inició construcción ${bestUpgrade} Nivel ${reqs.nextLevel}.`);
}


// Exportar la función para que el script de cron pueda llamarla
module.exports = { runEconomicUpdate };

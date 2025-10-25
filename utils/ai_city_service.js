/**
 * ai_city_service.js
 * Utilidades auxiliares para gestionar ciudades IA (tabla ai_cities).
 * Provee funciones tipo CRUD y ayudantes para bloquear y actualizar filas dentro de transacciones.
 */

const pool = require('../db');
const gameUtils = require('./gameUtils');
const { BUILDING_COSTS } = require('../constants/buildings');

async function listCities(clientOrPool, forUpdate = false) {
    const q = forUpdate ? 'SELECT * FROM ai_cities FOR UPDATE' : 'SELECT * FROM ai_cities';
    const res = clientOrPool.query ? await clientOrPool.query(q) : await pool.query(q);
    return res.rows.map(r => ({ id: r.id, name: r.name, created_at: r.created_at }));
}

async function getCityById(clientOrPool, id, forUpdate = false) {
    const q = forUpdate ? 'SELECT * FROM ai_cities WHERE id = $1 FOR UPDATE' : 'SELECT * FROM ai_cities WHERE id = $1';
    const res = clientOrPool.query ? await clientOrPool.query(q, [id]) : await pool.query(q, [id]);
    return res.rows.length ? res.rows[0] : null;
}

async function createCity(clientOrPool, cityData) {
    const q = `INSERT INTO ai_cities (name) VALUES ($1) RETURNING *`;
    const params = [cityData.name || 'IA City'];
    const res = clientOrPool.query ? await clientOrPool.query(q, params) : await pool.query(q, params);
    return res.rows[0];
}

/**
 * Create a paired entities row and ai_cities row so the AI city exists as a game entity.
 * Returns { entity, ai_city }
 */
async function createPairedCity(clientOrPool, cityData) {
    // Abrimos/obtenemos un cliente si se proporcionó un pool
    const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
    if (!usingClient) {
        // Use a new client transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await createPairedCity(client, cityData);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Using existing client
    const client = clientOrPool;

    // Compute initialResources: prefer explicit initialResources, otherwise use balanced AI defaults
    let initialResources = cityData.initialResources;
    if (!initialResources || Object.keys(initialResources).length === 0) {
        // Balanced defaults for AI cities (small starting push)
        const aiDefaults = {
            wood: 800,
            stone: 700,
            food: 1200,
            water: 200,
            coal: 100,
            clay: 100,
            honey: 400,
            wool: 400,
            copper: 800,
            leather: 400,
            gold: 3000
        };
        const resourcesService = require('./resourcesService');
        const rtRes = await resourcesService.getResourceTypesWithClient(client);
        initialResources = {};
        // Only assign values for known resource types; others default to 0
        rtRes.forEach(r => {
            const name = (r.name || '').toLowerCase();
            initialResources[name] = typeof aiDefaults[name] === 'number' ? aiDefaults[name] : 0;
        });
    }

    // 1. crear la fila de entidad usando el servicio compartido
    const entityService = require('./entityService');
        const entity = await entityService.createEntityWithResources(client, {
        user_id: cityData.user_id || null,
        faction_id: cityData.faction_id || null,
        type: cityData.type || 'cityIA',
        x_coord: cityData.x_coord || 0,
        y_coord: cityData.y_coord || 0,
        population: cityData.population || 1,
        initialResources
    });

    // 2. crear la fila en ai_cities y vincularla a la entidad
    const ai = await createCity(client, { name: cityData.name || `IA City ${entity.id}` });
    await client.query('UPDATE ai_cities SET entity_id = $1 WHERE id = $2', [entity.id, ai.id]);

    // 2b. Asegurarse de que resource_inventory está configurado con los initialResources deseados (defensivo)
    try {
        const resourcesService = require('./resourcesService');
        await resourcesService.setResourcesWithClientGeneric(client, entity.id, initialResources);
    } catch (rsErr) {
        // non-fatal: log and continue
        console.warn('Failed to initialize AI city resources in resource_inventory:', rsErr.message);
    }

    // Upsert defensivo adicional: garantizar que existe una fila en resource_inventory para cada tipo de recurso.
    // Protege contra casos donde el creador de entidades compartido no insertó filas (por ejemplo, desajuste de esquema).
    try {
        const resourcesService = require('./resourcesService');
        const rt = await resourcesService.getResourceTypesWithClient(client);
        for (const r of rt) {
            const name = (r.name || '').toLowerCase();
            const amount = typeof initialResources[name] === 'number' ? initialResources[name] : 0;
            // Use upsert to create or set the amount
            await client.query(
                `INSERT INTO resource_inventory (entity_id, resource_type_id, amount)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (entity_id, resource_type_id) DO UPDATE SET amount = EXCLUDED.amount`,
                [entity.id, r.id, amount]
            );
        }
    } catch (upErr) {
        console.warn('Failed to upsert resource_inventory defensive rows for AI city:', upErr.message);
    }

    // NO almacenar runtime en entities.ai_runtime para ciudades IA.
    // Las cantidades de recursos ya se inicializan en resource_inventory por createEntityWithResources.
    // Los edificios se persisten en la tabla `buildings` cuando la IA construye.

    return { entity, ai_city: ai };
}

async function deleteCityById(clientOrPool, id) {
    // Delete ai_cities row. Also delete any map_entities links and optionally entities if requested via options.
    const city = await getCityById(clientOrPool, id, false);
    if (!city) return null;
    const client = clientOrPool.query ? clientOrPool : pool;
    // Find linked entity via ai_cities.entity_id
    const aiRow = await client.query('SELECT entity_id FROM ai_cities WHERE id = $1', [id]);
    if (aiRow.rows.length > 0 && aiRow.rows[0].entity_id) {
        const entityService = require('./entityService');
        try {
            await entityService.deleteEntity(client, aiRow.rows[0].entity_id);
        } catch (e) {
            // fallback: attempt deletion via entityService using pool (centralized, no raw SQL)
            try {
                await entityService.deleteEntity(pool, aiRow.rows[0].entity_id);
            } catch (e2) {
                // If even that fails, log and continue (avoid raw SQL here to keep centralization)
                console.warn('Failed to delete linked entity via entityService fallback:', e2.message);
            }
        }
    }
    await client.query('DELETE FROM ai_cities WHERE id = $1', [id]);
    return city;
}

async function updateCityById(clientOrPool, id, changes) {
    // Build SET list dynamically for allowed fields
    const fields = [];
    const values = [];
    let idx = 1;
    const allowed = ['name'];
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) {
            fields.push(`${k} = $${idx}`);
            values.push(changes[k]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    const q = `UPDATE ai_cities SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    values.push(id);
    const res = clientOrPool.query ? await clientOrPool.query(q, values) : await pool.query(q, values);
    return res.rows.length ? res.rows[0] : null;
}


/**
 * Decide the best build candidate for a city given planner output and trade actions.
 * This centralizes selection heuristics so the engine can call it from multiple places.
 *
 * Parameters:
 *  - pool: pg pool or client
 *  - perception: snapshot from perceiveSnapshot (entityId, inventory, priceBaseMap, neighbors...)
 *  - buildPlannerResult: { candidates, rejectedDueToPopCount, houseCandidate }
 *  - tradeActions: planner-generated trade actions (optional)
 *  - opts: { safetyStock, findProducerChain (fn), missingResources: [], maxDepth }
 *
 * Returns: { bestBuild, bestTrade, rejectedDueToPopCount, houseCandidate }
 */
async function chooseBestBuild(pool, perception, buildPlannerResult, tradeActions, opts = {}) {
    opts = Object.assign({ safetyStock: 200, maxDepth: 4 }, opts || {});
    const entityId = perception && perception.entityId;
    const buildCandidates = (buildPlannerResult && buildPlannerResult.candidates) || [];
    const rejectedDueToPopCount = (buildPlannerResult && buildPlannerResult.rejectedDueToPopCount) || 0;
    const houseCandidate = (buildPlannerResult && buildPlannerResult.houseCandidate) || null;

    const topSlice = buildCandidates.slice(0, 10);

    // bestTrade candidate (first trade action) if any
    const bestTrade = (tradeActions && tradeActions.length > 0) ? tradeActions[0] : null;

    // 1) memory-driven prioritization (missingResources passed by caller)
    const missing = Array.isArray(opts.missingResources) ? opts.missingResources.map(m => m && m.toString().toLowerCase()) : [];
    if (missing && missing.length > 0) {
        const prodMatch = topSlice.find(c => c.produces && c.produces.some(p => missing.includes(p)));
        if (prodMatch) return { bestBuild: prodMatch, bestTrade, rejectedDueToPopCount, houseCandidate };
    }

    // 2) Compute deficits grouped by bucket (poor, burgess, patrician)
    try {
        const SAFETY = opts.safetyStock;
        const gameUtils = require('./gameUtils');
        const populationService = require('./populationService');
        const { getBuildings } = require('./buildingsService');

        const bRows = await getBuildings(entityId);
        // sum current population across buckets
        let totalPop = 0;
        try {
            const popRows = await populationService.getPopulationRowsWithClient(pool, entityId);
            for (const k of Object.keys(popRows || {})) totalPop += Number(popRows[k].current || 0);
        } catch (e) { totalPop = 0; }

        const prodPerTick = gameUtils.calculateProduction(bRows, { current_population: totalPop }) || {};

        const categoryMap = gameUtils.RESOURCE_CATEGORIES || {};
        function resourceBucketForResource(r) {
            const cat = categoryMap[r] || null;
            if (cat === 'common') return 'poor';
            if (cat === 'processed') return 'burgess';
            if (cat === 'specialized') return 'patrician';
            return null;
        }

        // gather deficits
        const deficits = { poor: new Set(), burgess: new Set(), patrician: new Set() };
        const keys = new Set([...(Object.keys(prodPerTick || {})), ...(Object.keys(perception.inventory || {}))]);
        for (const res of keys) {
            if (!res || res === 'gold') continue;
            const cur = Number(perception.inventory[res] || 0);
            const net = Number(prodPerTick[res] || 0);
            if (net < 0 || cur < SAFETY) {
                const bk = resourceBucketForResource(res);
                if (bk) deficits[bk].add(res);
            }
        }

        // Hybrid poor-first policy
        const poorDeficit = deficits.poor || new Set();
        if (poorDeficit.size > 0) {
            // If we are population-blocked and have a house candidate, try that first
            if (rejectedDueToPopCount > 0 && houseCandidate) return { bestBuild: houseCandidate, bestTrade, rejectedDueToPopCount, houseCandidate };

                // Otherwise attempt to find a producer chain for any poor resource.
                // Prefer an externally provided finder (opts.findProducerChain) but fall back
                // to the local `findProducerChain` implementation exported by this module.
                const chainFinder = (typeof opts.findProducerChain === 'function') ? opts.findProducerChain : findProducerChain;
                if (typeof chainFinder === 'function') {
                    for (const r of poorDeficit) {
                        try {
                            const chain = await chainFinder(r, { currentResources: perception.inventory || {}, runtimeBuildings: {}, calc: {}, maxDepth: opts.maxDepth || 4 });
                            if (Array.isArray(chain) && chain.length > 0) {
                                // pick the first element of chain if it's present in candidates
                                const first = chain[0];
                                const match = buildCandidates.find(c => c.buildingId === first || (c.buildingId && c.buildingId.toString().toLowerCase() === first.toString().toLowerCase()));
                                if (match) return { bestBuild: match, bestTrade, rejectedDueToPopCount, houseCandidate };
                            }
                        } catch (e) { /* ignore per-resource chain failures */ }
                    }
                }
        }

        // bucket-order pick
        const bucketOrder = ['poor', 'burgess', 'patrician'];
        for (const bk of bucketOrder) {
            if ((deficits[bk] || new Set()).size === 0) continue;
            const match = buildCandidates.find(c => c.produces && c.produces.some(p => deficits[bk].has(p)));
            if (match) return { bestBuild: match, bestTrade, rejectedDueToPopCount, houseCandidate };
        }
    } catch (e) {
        // if something fails, fall through to fallback picks
    }

    // Fallbacks: base preference or top candidate
    const BASE_PREF = ['sawmill', 'quarry', 'farm'];
    const basePick = topSlice.find(c => BASE_PREF.includes(c.buildingId));
    if (basePick) return { bestBuild: basePick, bestTrade, rejectedDueToPopCount, houseCandidate };
    if (buildCandidates && buildCandidates.length > 0) return { bestBuild: buildCandidates[0], bestTrade, rejectedDueToPopCount, houseCandidate };

    return { bestBuild: null, bestTrade, rejectedDueToPopCount, houseCandidate };
}

// Calculate upgrade requirements using BUILDING_COSTS (same formula as v1)
function calculateUpgradeRequirementsFromConstants(buildingType, currentLevel) {
    const costBase = BUILDING_COSTS[buildingType];
    if (!costBase) return null;
    const factor = 1.7;
    const nextLevel = currentLevel + 1;
    // Build requiredCost dynamically from costBase to include non-standard resource keys
    const requiredCost = {};
    for (const [k, v] of Object.entries(costBase || {})) {
        if (k === 'popNeeded' || k === 'popneeded' || k === 'pop') continue;
        const baseVal = Number(v || 0);
        requiredCost[k.toString().toLowerCase()] = Math.ceil(baseVal * Math.pow(nextLevel, factor));
    }
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
 * Busca recursivamente una cadena de edificios que permitan obtener `resourceName`.
 * Devuelve un array con el orden de construcción sugerido (primer elemento a construir primero).
 * options:
 *  - currentResources: mapa actual de inventario
 *  - runtimeBuildings: niveles actuales por edificio (map)
 *  - calc: resultado de populationService.calculateAvailablePopulation(entityId) (usa .available)
 *  - maxDepth: profundidad máxima (default 4)
 */
function findProducerChain(resourceName, options = {}) {
    if (!resourceName) return null;
    const key = resourceName.toString().toLowerCase();
    const prodRates = gameUtils.PRODUCTION_RATES || {};
    const recipes = gameUtils.PROCESSING_RECIPES || {};
    const BUILDING_COSTS_LOCAL = BUILDING_COSTS || {};

    const currentResources = options.currentResources || {};
    const runtimeBuildings = options.runtimeBuildings || {};
    const calc = options.calc || {};
    const maxDepthWanted = typeof options.maxDepth === 'number' ? options.maxDepth : 6; // allow deeper searches by default
    const MAX_HARD_CAP = 10; // absolute hard cap to avoid runaway
    const maxAttemptDepth = Math.min(MAX_HARD_CAP, Math.max(1, Math.floor(maxDepthWanted)));

    // inner recursive search with explicit remaining depth and local visited set
    function innerSearch(resourceKey, remainingDepth, visited) {
        if (!resourceKey) return null;
        const rk = resourceKey.toString().toLowerCase();
        if (remainingDepth <= 0) return null;
        if (visited.has(rk)) return null;
        visited.add(rk);

        // build direct candidate list
        const directCandidates = [];
        for (const [building, rates] of Object.entries(prodRates)) {
            if (rates && Object.prototype.hasOwnProperty.call(rates, rk) && Number(rates[rk]) > 0) directCandidates.push(building);
        }
        if (directCandidates.length === 0) {
            for (const [building, rates] of Object.entries(prodRates)) {
                if (!rates) continue;
                for (const produced of Object.keys(rates)) {
                    const p = produced.toString().toLowerCase();
                    if (p.includes(rk) || rk.includes(p)) {
                        if (!directCandidates.includes(building)) directCandidates.push(building);
                    }
                }
                if (building.toString().toLowerCase().includes(rk) && !directCandidates.includes(building)) directCandidates.push(building);
            }
        }

        // Try each candidate: either it's directly buildable or we need to resolve its missing inputs
        for (const candidate of directCandidates) {
            try {
                const curLevel = runtimeBuildings[candidate] || 0;
                const reqs = calculateUpgradeRequirementsFromConstants(candidate, curLevel);
                if (!reqs) continue;
                const prodPopNeeded = (reqs.popForNextLevel || 0) - (reqs.currentPopRequirement || 0);
                if ((calc.available || 0) < prodPopNeeded) continue;

                const missing = [];
                for (const r in reqs.requiredCost) {
                    const needAmt = reqs.requiredCost[r] || 0;
                    const haveAmt = Number(currentResources[r] || 0);
                    if (haveAmt < needAmt) missing.push(r);
                }
                if (missing.length === 0) return [candidate];

                // recursively resolve missing inputs
                for (const m of missing) {
                    const sub = innerSearch(m, remainingDepth - 1, new Set(visited));
                    if (Array.isArray(sub) && sub.length > 0) return sub.concat([candidate]);
                }
            } catch (e) {
                console.warn('[AI v2] innerSearch candidate error for', candidate, e && e.message);
                continue;
            }
        }

        // Try recipes: if resource is a processed product, attempt to resolve its inputs recursively
        if (recipes && recipes[rk]) {
            const inputs = Object.keys(recipes[rk] || {});
            for (const inRes of inputs) {
                const sub = innerSearch(inRes, remainingDepth - 1, new Set(visited));
                if (Array.isArray(sub) && sub.length > 0) {
                    for (const [b, rates] of Object.entries(prodRates)) {
                        if (rates && Number(rates[rk]) > 0) return sub.concat([b]);
                    }
                }
            }
        }

        return null;
    }

    // Iterative deepening: increase depth until we find a chain or hit cap
    for (let depth = 1; depth <= maxAttemptDepth; depth++) {
        try {
            const result = innerSearch(key, depth, new Set());
            if (Array.isArray(result) && result.length > 0) return result;
        } catch (e) {
            console.warn('[AI v2] findProducerChain innerSearch failed at depth', depth, e && e.message);
        }
    }

    return null;
}

// Map a building type to population bucket
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
        if (cat === 'strategic') return 'patrician';
    }
    if (key.includes('farm') || key.includes('well') || key.includes('sawmill') || key.includes('quarry')) return 'poor';
    if (key.includes('carpinter') || key.includes('fabrica') || key.includes('alfareria') || key.includes('tintoreria')) return 'burgess';
    return 'poor';
}

// Allow checking whether building a house is allowed for a bucket (centralized)
async function isHouseBuildAllowed(poolRef, entityId, buildingIdLocal) {
    if (!buildingIdLocal) return true;
    const lower = buildingIdLocal.toString().toLowerCase();
    let bucketToCheck = null;
    if (lower === 'house' || lower === 'house' || lower === 'casa') bucketToCheck = 'poor';
    else if (lower === 'casa_de_piedra' || lower.includes('piedra')) bucketToCheck = 'burgess';
    else if (lower === 'casa_de_ladrillos' || lower.includes('ladrill')) bucketToCheck = 'patrician';
    if (!bucketToCheck) return true;
    try {
        const populationServiceLocal = require('./populationService');
        const client = await (poolRef.connect ? poolRef.connect() : pool.connect());
        try {
            const row = await populationServiceLocal.getPopulationByTypeWithClient(client, entityId, bucketToCheck);
            const cur = Number(row.current || 0);
            const maxv = Number(row.max || 0);
            if (cur !== maxv) return false;

            // compute production for commons and require total > 0
            try {
                const { getBuildings } = require('./buildingsService');
                const gameUtilsLocal = require('./gameUtils');
                const bRows = await getBuildings(entityId);
                let totalPop = 0;
                try {
                    const popRows = await populationServiceLocal.getPopulationRowsWithClient(client, entityId);
                    for (const k of Object.keys(popRows || {})) totalPop += Number(popRows[k].current || 0);
                } catch (e) { totalPop = 0; }
                const prodPerTick = gameUtilsLocal.calculateProduction(bRows, { current_population: totalPop }) || {};
                const cats = gameUtilsLocal.RESOURCE_CATEGORIES || {};
                let totalCommonNet = 0;
                for (const r of Object.keys(cats)) {
                    if (cats[r] === 'common') totalCommonNet += Number(prodPerTick[r] || 0);
                }
                return totalCommonNet > 0;
            } catch (e) {
                return false;
            }
        } finally {
            try { client.release(); } catch (e) { /* ignore */ }
        }
    } catch (e) {
        return false;
    }
}

// Compute a summary of common resource deficits for logging/decisions
async function computeCommonDeficitSummary(poolRef, entityId, opts = {}) {
    const SAFETY = (opts && opts.safetyStock) || 200;
    try {
        const { getBuildings } = require('./buildingsService');
        const populationServiceLocal = require('./populationService');
        const bRows = await getBuildings(entityId);
        let totalPop = 0;
        try {
            const popRows = await populationServiceLocal.getPopulationRowsWithClient(poolRef, entityId);
            for (const k of Object.keys(popRows || {})) totalPop += Number(popRows[k].current || 0);
        } catch (e) { totalPop = 0; }
        const prodPerTick = gameUtils.calculateProduction(bRows, { current_population: totalPop }) || {};
        const cats = gameUtils.RESOURCE_CATEGORIES || {};
        const commonKeys = Object.keys(cats).filter(k => cats[k] === 'common');
        const factor = 60 / (gameUtils.TICK_SECONDS || 60);
        const summary = {};
        for (const res of commonKeys) {
            const stock = 0; // caller likely has perception.inventory; keep 0 as placeholder
            const netPerTick = Number(prodPerTick[res] || 0);
            const perMinute = netPerTick * factor;
            const status = (netPerTick < 0 || stock < SAFETY) ? 'deficit' : 'surplus';
            summary[res] = { stock, netPerTick, perMinute, status, safety: SAFETY };
        }
        return summary;
    } catch (e) {
        return {};
    }
}

// Compute effective payback threshold for a candidate given urgency and inventory
function computeEffectiveThresholdForCandidate(candidate, perception, opts = {}) {
    const SAFETY = (opts && opts.safetyStock) || 200;
    const PAYBACK_THRESHOLD = (opts && opts.paybackThreshold) || 2000;
    const OVERRIDE_PRIORITY_BOOST = (typeof (opts && opts.overridePriorityBoost) === 'number') ? opts.overridePriorityBoost : 8;
    if (!candidate) return PAYBACK_THRESHOLD;
    if ((candidate.priorityBoost || 0) >= OVERRIDE_PRIORITY_BOOST) return Infinity;
    try {
        const produces = candidate.produces || [];
        for (const r of produces) {
            const have = Number(perception.inventory && perception.inventory[r] || 0);
            if (have < SAFETY) return Infinity;
        }
    } catch (e) { /* ignore */ }
    return PAYBACK_THRESHOLD;
}

module.exports = {
    listCities,
    getCityById,
    createCity,
    createPairedCity,
    deleteCityById,
    updateCityById,
    chooseBestBuild,
    calculateUpgradeRequirementsFromConstants,
    findProducerChain
};

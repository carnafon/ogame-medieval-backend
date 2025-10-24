/**
 * ai_economic_engine_v2.js
 * Minimal, safe skeleton for a next-gen AI economic engine.
 * Exposes runBatch(pool, options) and runCityTick(pool, cityId, options).
 * Implement full planners/executors in separate modules (not included here).
 */


const poolModule = require('../db');
const aiCityService = require('../utils/ai_city_service');
const marketService = require('../utils/marketService');
const resourcesService = require('../utils/resourcesService');
const populationService = require('../utils/populationService');
const { getBuildings } = require('../utils/buildingsService');
const gameUtils = require('../utils/gameUtils');
const { BUILDING_COSTS } = require('../constants/buildings');

// Default trading parameters
const DEFAULTS = {
  MAX_NEIGHBORS: 8,
  MAX_TRADES_PER_TICK: 60,
  MAX_AMOUNT: 100,
  SAFETY_STOCK: 200,
  PROFIT_MARGIN: 1.05, // only sell if market price >= base * PROFIT_MARGIN
};

// Simple in-memory metrics (reset on server restart). For canary this is sufficient; later push to external metrics.
const metrics = {
  ticksRun: 0,
  citiesProcessed: 0,
  actionsExecuted: 0,
  successfulTrades: 0,
  successfulBuilds: 0,
  failedActions: 0,
  lastRunAt: null,
};

// Simple in-memory AI memory for canary: Map<entityId, { missing: Set<string>, lastUpdated: number }>
const aiMemory = new Map();

function pushMissingResourceToMemory(entityId, resource) {
  if (!entityId || !resource) return;
  const key = Number(entityId);
  const cur = aiMemory.get(key) || { missing: new Set(), lastUpdated: Date.now() };
  cur.missing.add(resource.toString().toLowerCase());
  cur.lastUpdated = Date.now();
  aiMemory.set(key, cur);
}

function getMissingResourcesFromMemory(entityId) {
  const key = Number(entityId);
  const cur = aiMemory.get(key);
  if (!cur || !cur.missing) return new Set();
  return new Set(Array.from(cur.missing));
}

function clearMissingResourcesFromMemory(entityId, resourcesToClear) {
  const key = Number(entityId);
  const cur = aiMemory.get(key);
  if (!cur) return;
  if (!resourcesToClear) { aiMemory.delete(key); return; }
  for (const r of resourcesToClear) cur.missing.delete(r.toString().toLowerCase());
  if (cur.missing.size === 0) aiMemory.delete(key); else cur.lastUpdated = Date.now();
}

function recordMetric(key, delta = 1) {
  if (typeof metrics[key] === 'number') metrics[key] += delta;
}

function getMetrics() {
  return Object.assign({}, metrics);
}

function resetMetrics() {
  metrics.ticksRun = 0; metrics.citiesProcessed = 0; metrics.actionsExecuted = 0; metrics.successfulTrades = 0; metrics.successfulBuilds = 0; metrics.failedActions = 0; metrics.lastRunAt = null;
}

function logEvent(event) {
  // Structured JSON log; keep compact
  try { console.debug('[AI v2][event] ' + JSON.stringify(event)); } catch (e) { console.debug('[AI v2][event] (could not stringify)'); }
}

// Perception: snapshot of entity inventory, coords, and price_base map
async function perceiveSnapshot(pool, entityId, opts = {}) {
  const client = pool;
  // load coords via entityService
  const entityService = require('../utils/entityService');
  const coords = await entityService.getEntityCoords(client, entityId);
  const x = coords.x_coord || 0;
  const y = coords.y_coord || 0;

  // load inventory via resourcesService
  const inventory = await resourcesService.getResourcesWithClient(client, entityId);

  // load price_base map via resourcesService
  const priceBaseMap = await resourcesService.getPriceBaseMapWithClient(client);

  // find nearby AI city entities (limited) via entityService
  const nbRows = await entityService.listNearbyAICities(client, entityId, opts.maxNeighbors || DEFAULTS.MAX_NEIGHBORS);
  const neighbors = (nbRows || []).map(r => ({ id: r.id, x: r.x_coord, y: r.y_coord }));
  
  return { entityId, x, y, inventory, priceBaseMap, neighbors };
}
// Trade planner: produce a list of trade actions { type: 'buy'|'sell', resource, qty, counterpartyId }
function tradePlanner(perception, opts = {}) {
  const { inventory, priceBaseMap, neighbors } = perception;
  const MAX_TRADES = opts.maxTradesPerTick || DEFAULTS.MAX_TRADES_PER_TICK;
  const MAX_AMOUNT = opts.maxAmount || DEFAULTS.MAX_AMOUNT;
  const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
  const BASE_BUY_DIV = opts.baseBuyDiv || 120;
  const BASE_SELL_DIV = opts.baseSellDiv || 500;

  const actions = [];

  // simple buy strategy: if our amount < buyLow, attempt to buy from neighbors
  for (const [resName, curAmt] of Object.entries(inventory)) {
    if (resName === 'gold') continue;
    const base = priceBaseMap[resName] || 1;
    const buyLow = Math.max(1, Math.round(BASE_BUY_DIV / base));
    if (curAmt < buyLow) {
      const need = Math.min(MAX_AMOUNT, buyLow - curAmt);
      // plan a buy but counterparty chosen at execution time (prefer neighbors with > safety)
      actions.push({ type: 'buy', resource: resName, qty: need, score: (buyLow - curAmt) * base });
    }
  }

  // simple sell strategy: if our amount > sellHigh, attempt to sell surplus to neighbors
  for (const [resName, curAmt] of Object.entries(inventory)) {
    if (resName === 'gold') continue;
    const base = priceBaseMap[resName] || 1;
    const buyLow = Math.max(1, Math.round(BASE_BUY_DIV / base));
    const sellHigh = Math.max(buyLow + 1, Math.round(BASE_SELL_DIV / base));
    if (curAmt > sellHigh) {
      const surplus = curAmt - sellHigh;
      const toSell = Math.min(MAX_AMOUNT, surplus);
      actions.push({ type: 'sell', resource: resName, qty: toSell, score: surplus * base });
    }
  }

  // sort actions by score desc (higher economic impact first)
  actions.sort((a, b) => b.score - a.score);
  return actions.slice(0, MAX_TRADES);
}

// Execute a trade action safely inside a DB transaction using marketService
async function executeTradeAction(pool, action, perception, opts = {}) {
  const MAX_AMOUNT = opts.maxAmount || DEFAULTS.MAX_AMOUNT;
  const PROFIT_MARGIN = opts.profitMargin || DEFAULTS.PROFIT_MARGIN;

  const resource = action.resource.toString().toLowerCase();
  const qty = Math.max(1, Math.min(MAX_AMOUNT, Math.floor(action.qty || 0)));
  if (qty <= 0) return { success: false, reason: 'invalid_qty' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get price_base and compute market price for desired qty
    const mp = await marketService.computeMarketPriceSingle(client, resource, qty, action.type === 'buy' ? 'buy' : 'sell');
    if (!mp) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'no_market_price' };
    }

    const base = (perception.priceBaseMap && perception.priceBaseMap[resource]) || 1;

    if (action.type === 'sell') {
      // Only sell if mp.price >= base * profit_margin
      if (mp.price < Math.ceil(base * PROFIT_MARGIN)) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'price_below_margin', price: mp.price, base };
      }
      // find a neighbor to buy (one with inventory < buyLow)
      let buyerId = null;
      for (const nb of perception.neighbors) {
        const nInv = await resourcesService.getResourcesWithClient(client, nb.id);
        const neighborAmt = (nInv && nInv[resource]) || 0;
        const buyLow = Math.max(1, Math.round((opts.baseBuyDiv || 120) / base));
        if (neighborAmt < buyLow) { buyerId = nb.id; break; }
      }
      if (!buyerId) { await client.query('ROLLBACK'); return { success: false, reason: 'no_buyer' }; }

      // Execute trade: seller = our entityId, buyer = buyerId
      try {
        const snapshot = await marketService.tradeWithClient(client, buyerId, perception.entityId, resource, mp.price, qty);
        await client.query('COMMIT');
        recordMetric('actionsExecuted', 1); recordMetric('successfulTrades', 1);
        logEvent({ type: 'trade', action: 'sell', entityId: perception.entityId, resource, qty, price: mp.price, buyerId });
        return { success: true, snapshot, price: mp.price };
      } catch (tradeErr) {
        await client.query('ROLLBACK');
        recordMetric('failedActions', 1);
        logEvent({ type: 'trade', action: 'sell', entityId: perception.entityId, resource, qty, reason: 'trade_failed', err: tradeErr && tradeErr.message });
        return { success: false, reason: 'trade_failed', err: tradeErr && tradeErr.message };
      }

    } else {
      // BUY: find a neighbor seller with available stock > safety
      let sellerId = null;
      for (const nb of perception.neighbors) {
        const nInv = await resourcesService.getResourcesWithClient(client, nb.id);
        const sellerStock = (nInv && nInv[resource]) || 0;
        if (sellerStock > (opts.safetyStock || DEFAULTS.SAFETY_STOCK)) { sellerId = nb.id; break; }
      }
      if (!sellerId) { await client.query('ROLLBACK'); return { success: false, reason: 'no_seller' }; }

      try {
        const snapshot = await marketService.tradeWithClient(client, perception.entityId, sellerId, resource, mp.price, qty);
        await client.query('COMMIT');
        recordMetric('actionsExecuted', 1); recordMetric('successfulTrades', 1);
        logEvent({ type: 'trade', action: 'buy', entityId: perception.entityId, resource, qty, price: mp.price, sellerId });
        return { success: true, snapshot, price: mp.price };
      } catch (tradeErr) {
        await client.query('ROLLBACK');
        recordMetric('failedActions', 1);
        logEvent({ type: 'trade', action: 'buy', entityId: perception.entityId, resource, qty, reason: 'trade_failed', err: tradeErr && tradeErr.message });
        return { success: false, reason: 'trade_failed', err: tradeErr && tradeErr.message };
      }
    }
  } finally {
    try { client.release(); } catch (e) { /* ignore */ }
  }
}

// Helper: determine population bucket for a building type
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
  if (key.includes('farm') || key.includes('well') || key.includes('sawmill') || key.includes('quarry')) return 'poor';
  if (key.includes('carpinter') || key.includes('fabrica') || key.includes('alfareria') || key.includes('tintoreria')) return 'burgess';
  return 'poor';
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

// Build planner: rank building upgrades by payback time (cost in gold / marginal value per tick)
async function buildPlanner(perception, pool, opts = {}) {
  const priceBaseMap = perception.priceBaseMap || {};
  const entityId = perception.entityId;
  // load current buildings (light read)
  const buildingRows = await getBuildings(entityId);
  const runtimeBuildings = {};
  buildingRows.forEach(b => { runtimeBuildings[b.type] = b.level || 0; });

  const candidates = [];
  const prodRatesAll = gameUtils.PRODUCTION_RATES || {};

    // helper: try to resolve a productionRates key for a buildingId with normalization and small map
    function resolveProdKey(buildingId) {
      if (!buildingId) return null;
      if (prodRatesAll[buildingId]) return buildingId;
      const lower = buildingId.toString().toLowerCase();
      if (prodRatesAll[lower]) return lower;
      // small custom mapping for spanish/english variants
      const canonicalMap = {
        'casa_de_piedra': 'house',
        'casa_de_ladrillos': 'house',
        'casa': 'house',
        // english/spanish synonyms
        'aserradero': 'sawmill', 'sawmill': 'sawmill',
        'cantera': 'quarry', 'quarry': 'quarry',
        'granja': 'farm', 'farm': 'farm',
        'pozo': 'well', 'well': 'well',
        'clay_pit': 'clay_pit', 'claypit': 'clay_pit',
        'tannery': 'tannery', 'curtiduria': 'tannery',
        'mina_carbon': 'coal_mine', 'coal_mine': 'coal_mine', 'carbon_mina': 'coal_mine',
        'mina_cobre': 'copper_mine', 'copper_mine': 'copper_mine',
        'sheepfold': 'sheepfold', 'ovelario': 'sheepfold',
        'apiary': 'apiary', 'colmenar': 'apiary',
        'sastreria': 'sastreria', 'carpinteria': 'carpinteria', 'carpintero': 'carpinteria',
        'fabrica_ladrillos': 'fabrica_ladrillos', 'bazar_especias': 'bazar_especias',
        'alfareria': 'alfareria', 'tintoreria_morada': 'tintoreria_morada',
        'herreria': 'herreria', 'forja': 'forja',
        'salazoneria': 'salazoneria', 'libreria': 'libreria', 'cerveceria': 'cerveceria',
        'elixireria': 'elixireria', 'tintoreria_real': 'tintoreria_real', 'escriba': 'escriba',
        'artificiero': 'artificiero', 'herreria_real': 'herreria_real', 'lineria': 'lineria',
        'tintoreria_dorada': 'tintoreria_dorada', 'herreria_mitica': 'herreria_mitica',
        'salinas': 'salinas', 'mina_azufre': 'mina_azufre', 'mina_gemas': 'mina_gemas', 'telar_real': 'telar_real'
      };
      if (canonicalMap[lower] && prodRatesAll[canonicalMap[lower]]) return canonicalMap[lower];
      // try stripping common suffixes/prefixes
      const stripped = lower.replace(/^(la_|el_|the_)/, '').replace(/_build|_building|_edificio/g, '');
      if (prodRatesAll[stripped]) return stripped;
      return null;
    }

  // compute population stats for consumption
  let populationStats = { current_population: 0 };
  try {
    const populationService = require('../utils/populationService');
    const popRows = await populationService.getPopulationRowsWithClient(pool, entityId);
    let total = 0;
    for (const k of Object.keys(popRows || {})) {
      total += Number(popRows[k].current || 0);
    }
    populationStats.current_population = total;
  } catch (e) {
    // leave defaults if query fails
  }

  // compute current net production per tick (includes consumption)
  const productionPerTick = gameUtils.calculateProduction(buildingRows, populationStats) || {};
  const horizonSeconds = opts.horizonSeconds || (gameUtils.TICK_SECONDS * 6); // default 6 ticks

  for (const buildingId of Object.keys(BUILDING_COSTS)) {
    const currentLevel = runtimeBuildings[buildingId] || 0;
    const reqs = calculateUpgradeRequirementsFromConstants(buildingId, currentLevel);
    if (!reqs) continue;

    // cost in gold-equivalent
    let costGold = 0;
    for (const r in reqs.requiredCost) {
      const amt = reqs.requiredCost[r] || 0;
      const base = priceBaseMap[r] || 1;
      costGold += amt * base;
    }

  // estimate marginal production value per tick (pre-adjust)
    const prodKey = resolveProdKey(buildingId);
    const rates = prodKey ? (prodRatesAll[prodKey] || {}) : {};
    if (!prodKey) {
      const availableKeys = Object.keys(prodRatesAll || {}).slice(0, 80);
      logEvent({ type: 'build_prod_key_missing', entityId, buildingId, note: 'no matching production key', availableProductionKeys: availableKeys });
    } else if (prodKey !== buildingId) {
      logEvent({ type: 'build_prod_key_mapped', entityId, buildingId, usedKey: prodKey });
    }
    // Compute a raw production score (sum of production rates) instead of market-weighted value
    // We'll prioritize buildings based on the city's own inventory/deficits rather than market prices.
    let rawValueSum = 0;
    for (const res of Object.keys(rates)) {
      const rate = Number(rates[res]) || 0;
      rawValueSum += rate; // per level production magnitude
    }

    // Determine if this building should be excluded from production-value calculations
    const lowerId = (buildingId || '').toString().toLowerCase();
    const isSpecialProduction = (lowerId.includes('house') || lowerId.includes('casa') || lowerId.includes('sawmill') || lowerId.includes('aserradero') || lowerId.includes('quarry') || lowerId.includes('cantera') || lowerId.includes('farm') || lowerId.includes('granja'));

    if (rawValueSum <= 0 && !isSpecialProduction) {
      const perceptionSnapshotForLog = {
        inventory: perception && perception.inventory ? perception.inventory : {},
        x: perception && typeof perception.x !== 'undefined' ? perception.x : null,
        y: perception && typeof perception.y !== 'undefined' ? perception.y : null,
        neighborsCount: perception && perception.neighbors ? perception.neighbors.length : 0
      };
      logEvent({ type: 'build_candidate_skipped', entityId, buildingId, reason: 'no_production_value', valueSum: rawValueSum, perception: perceptionSnapshotForLog });
      continue; // skip non-producer buildings for now
    }

    // Adjust valueSum based on current stock and consumption urgency (use inventory, not market prices)
    let adjustedValueSum = rawValueSum;
    try {
      const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
      const multiplierParts = [];
      for (const res of Object.keys(rates)) {
        const produces = Number(rates[res]) || 0;
        const netPerTick = Number(productionPerTick[res] || 0);
        const projectedNet = netPerTick * (horizonSeconds / gameUtils.TICK_SECONDS);
        const curStock = Number(perception.inventory[res] || 0);

        // If projected net is negative (deficit) or stock low => increase value
        if (projectedNet < 0 || curStock < SAFETY) {
          const deficit = Math.max(0, -projectedNet);
          const stockGap = Math.max(0, SAFETY - curStock);
          // urgency: deficit relative to safety and current stock
          const urgency = 1 + Math.min(4, (stockGap / Math.max(1, SAFETY)) + (deficit / Math.max(1, SAFETY)));
          multiplierParts.push(urgency);
        } else if (curStock > SAFETY * 3) {
          // overstock -> reduce immediate value
          multiplierParts.push(0.5);
        } else {
          multiplierParts.push(1);
        }
      }
      // combine multipliers (geometric mean-ish)
      const combined = multiplierParts.reduce((a, b) => a * b, 1) ** (1 / Math.max(1, multiplierParts.length));
      adjustedValueSum = rawValueSum * combined;
    } catch (e) {
      adjustedValueSum = rawValueSum;
    }

  const payback = costGold / Math.max(1, adjustedValueSum);

    // Compute a simple priority boost if this candidate produces resources that are
    // currently in deficit or below safety stock. This will be used by the planner
    // to prefer urgent producers even if payback is slightly worse.
    let priorityBoost = 0;
    try {
      const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
      for (const res of Object.keys(rates)) {
        const producesAmt = Number(rates[res]) || 0;
        if (producesAmt <= 0) continue;
        const netPerTick = Number(productionPerTick[res] || 0);
        const curStock = Number(perception.inventory[res] || 0);
        // if net production is negative -> deficit
        if (netPerTick < 0) {
          // larger deficits get stronger boost
          const deficit = Math.abs(netPerTick);
          priorityBoost += 5 * (1 + deficit / Math.max(1, Math.abs(netPerTick) + 1));
        }
        // if current stock below safety -> boost
        if (curStock < SAFETY) {
          const gap = SAFETY - curStock;
          priorityBoost += 3 * (1 + gap / Math.max(1, SAFETY));
        }
      }
    } catch (e) {
      priorityBoost = 0;
    }

    // determine target population bucket and simple population check (current < max)
    const bucket = mapBuildingToPopulationBucket(buildingId);
    let perTypeMax = null;
    let perTypeCurrent = null;
    let perTypeAvailable = null;
    try {
      const populationService = require('../utils/populationService');
      const tmp = await pool.connect();
      try {
        const row = await populationService.getPopulationByTypeWithClient(tmp, entityId, bucket);
        perTypeCurrent = Number(row.current || 0);
        perTypeMax = Number(row.max || 0);
        perTypeAvailable = Number(row.available || Math.max(0, perTypeMax - perTypeCurrent));
      } finally { tmp.release(); }
    } catch (e) {
      perTypeMax = null;
    }

  // Determine if there is capacity for population this building may require.
  // If popNeeded is specified in BUILDING_COSTS we must ensure there's room for that many new population units
  // unless the building is a house (which increases capacity instead of consuming it).
  const popNeeded = (reqs && reqs.popForNextLevel) ? Number(reqs.popForNextLevel || 0) : 0;
  const isHouseType = buildingId === 'house' || buildingId.startsWith('casa') || buildingId.startsWith('house');
  const hasCapacity = (perTypeMax === null) || (perTypeCurrent < perTypeMax) || isHouseType;
  // Also mark whether available population slots are sufficient for popNeeded (if popNeeded > 0)
  const availableSlots = (perTypeAvailable === null) ? ((perTypeMax === null) ? Infinity : Math.max(0, perTypeMax - perTypeCurrent)) : perTypeAvailable;
  const hasEnoughPopSlots = isHouseType ? true : (availableSlots >= popNeeded);
    // which resources does this building produce (positive rate)
    const produces = Object.keys(rates || {}).filter(k => (Number(rates[k]) || 0) > 0);
    // primary produced resource (highest weighted by price)
    let primaryProduce = null;
    try {
      primaryProduce = produces.slice().sort((a,b)=>{
        const va = (Number(rates[a])||0) * (priceBaseMap[a]||1);
        const vb = (Number(rates[b])||0) * (priceBaseMap[b]||1);
        return vb - va;
      })[0] || null;
    } catch(e) { primaryProduce = produces[0] || null; }

    candidates.push({ buildingId, currentLevel, reqs, costGold, valueSum: rawValueSum, adjustedValueSum, payback, bucket, hasCapacity, perTypeMax, perTypeAvailable, hasEnoughPopSlots, produces, primaryProduce, priorityBoost });
  }

  // Filter out candidates that explicitly require population slots we don't have (unless they are house types)
  const filteredCandidates = candidates.filter(c => {
    const isHouseTypeLocal = c.buildingId === 'house' || c.buildingId.startsWith('casa') || c.buildingId.startsWith('house');
    // If perTypeAvailable is explicitly 0 or null for non-house types, it's likely uninitialized or zero available; filter out
    if (!isHouseTypeLocal && (c.perTypeAvailable === null || c.perTypeAvailable === 0)) return false;
    if (isHouseTypeLocal) return true;
    if (typeof c.hasEnoughPopSlots === 'boolean' && !c.hasEnoughPopSlots) return false;
    return true;
  });

  // prefer candidates with hasCapacity true and lower payback
  filteredCandidates.sort((a, b) => {
    if (a.hasCapacity !== b.hasCapacity) return a.hasCapacity ? -1 : 1;
    if ((b.priorityBoost || 0) !== (a.priorityBoost || 0)) return (b.priorityBoost || 0) - (a.priorityBoost || 0);
    return a.payback - b.payback;
  });

  const rejectedDueToPopCount = (candidates || []).length - (filteredCandidates || []).length;
  // detect if there was a house-type candidate in the original candidate list (useful to attempt building capacity)
  const houseCandidate = (candidates || []).find(c => {
    return (c.buildingId === 'house' || c.buildingId.startsWith('casa') || c.buildingId.startsWith('house'));
  }) || null;

  if (!filteredCandidates || filteredCandidates.length === 0) {
    logEvent({ type: 'build_planner_no_candidates', entityId, reason: 'no_viable_candidates', priceBaseMap, rejectedDueToPopCount });
  } else {
    logEvent({ type: 'build_planner_candidates', entityId, count: filteredCandidates.length, top: filteredCandidates[0], rejectedDueToPopCount });
  }

  return { candidates: filteredCandidates, rejectedDueToPopCount, houseCandidate };
}

// Execute build action atomically: deduct resources, persist building level, and update populations for houses
async function executeBuildAction(pool, candidate, perception, opts = {}) {
  const entityId = perception.entityId;
  const reqs = candidate.reqs;
  const buildingId = candidate.buildingId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

  // lock resource inventory rows for entity and re-check via resourcesService
  await resourcesService.lockResourceRowsWithClient(client, entityId);
  const currentResources = await resourcesService.getResourcesWithClient(client, entityId);

      for (const r in reqs.requiredCost) {
      const needAmt = reqs.requiredCost[r] || 0;
      if ((currentResources[r] || 0) < needAmt) {
        // detailed missing resources log
        const have = (currentResources[r] || 0);
        logEvent({ type: 'build_failed_insufficient_resources', entityId, buildingId, resource: r, need: needAmt, have });
        // store missing resource in AI memory so next tick we can prioritize producer buildings
        try { pushMissingResourceToMemory(entityId, r); } catch (e) { /* ignore */ }
        await client.query('ROLLBACK');
        return { success: false, reason: 'insufficient_resources', resource: r, need: needAmt, have };
      }
    }

    // population check: ensure there are enough per-type slots unless building is a house
    const bucket = mapBuildingToPopulationBucket(buildingId);
    // Use populationService to lock/obtain the per-type row and check capacity within the same transaction
    // Add an explicit FOR UPDATE to avoid races with concurrent ticks/actions
    try {
      await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [entityId]);
    } catch (e) {
      // ignore if table/rows missing; populationService will handle it
    }
    const popRow = await populationService.getPopulationByTypeWithClient(client, entityId, bucket);
    if (popRow) {
      const cur = Number(popRow.current || 0);
      const maxv = Number(popRow.max || 0);
      const popNeededForThisBuild = (reqs && typeof reqs.popForNextLevel === 'number') ? Number(reqs.popForNextLevel) : 0;
      const isHouseTypeLocal = buildingId === 'house' || buildingId.startsWith('casa') || buildingId.startsWith('house');
      // Diagnostic log to help debug population enforcement
      const reportedAvailable = Number(popRow.available !== undefined ? popRow.available : Math.max(0, maxv - cur));
      logEvent({ type: 'build_population_check', entityId, buildingId, bucket, popRow: { current: cur, max: maxv, available: reportedAvailable }, popNeeded: popNeededForThisBuild, isHouse: isHouseTypeLocal });

      // If population row exists but max is zero (not initialized), treat as no capacity for non-house builds
      if (!isHouseTypeLocal && maxv === 0) {
        logEvent({ type: 'build_failed_population_not_initialized', entityId, buildingId, bucket, current: cur, max: maxv });
        await client.query('ROLLBACK');
        return { success: false, reason: 'population_not_initialized', bucket, current: cur, max: maxv };
      }

      // If building consumes population (popNeededForThisBuild > 0) ensure there are enough available slots
      const available = reportedAvailable;
      if (!isHouseTypeLocal && popNeededForThisBuild > 0 && available < popNeededForThisBuild) {
        logEvent({ type: 'build_failed_population_insufficient_slots', entityId, buildingId, bucket, current: cur, max: maxv, popNeeded: popNeededForThisBuild, available });
        await client.query('ROLLBACK');
        return { success: false, reason: 'population_insufficient_slots', bucket, current: cur, max: maxv, popNeeded: popNeededForThisBuild, available };
      }

      // Previously we also rejected when current >= max; that can conflict with available slots
      // (e.g., available reported > 0 while current == max due to computed 'available'), so prefer
      // the explicit available check above. Do not reject solely on cur >= max here.
    }

    // Deduct resources using generic consumer helper
    const costs = {};
    for (const r in reqs.requiredCost) { const amount = reqs.requiredCost[r] || 0; if (amount > 0) costs[r.toString().toLowerCase()] = amount; }
    try {
      await resourcesService.consumeResourcesWithClientGeneric(client, entityId, costs);
      for (const r in costs) logEvent({ type: 'build_deduct_resource', entityId, buildingId, resource: r, amount: costs[r] });
    } catch (consErr) {
      // log and rollback
      logEvent({ type: 'build_failed_consume', entityId, buildingId, err: consErr && consErr.message });
      await client.query('ROLLBACK');
      return { success: false, reason: 'insufficient_resources', resource: consErr && consErr.resource };
    }

    // Persist building level increment
    // Persist building level increment via buildingsService helpers
    const { incrementBuildingLevelWithClient } = require('../utils/buildingsService');
    await incrementBuildingLevelWithClient(client, entityId, buildingId);

    // If house-type built, update population max bucket
    try {
      const gu = require('../utils/gameUtils');
      const inc = gu.POPULATION_PER_HOUSE || 5;
      if (buildingId === 'casa_de_piedra') {
        const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'burgess');
        const cur = Number(prow.current || 0);
        const maxv = Number(prow.max || 0) + inc;
        await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'burgess', cur, maxv);
      } else if (buildingId === 'casa_de_ladrillos') {
        const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'patrician');
        const cur = Number(prow.current || 0);
        const maxv = Number(prow.max || 0) + inc;
        await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'patrician', cur, maxv);
      } else if (buildingId === 'house') {
        const prow = await populationService.getPopulationByTypeWithClient(client, entityId, 'poor');
        const cur = Number(prow.current || 0);
        const maxv = Number(prow.max || 0) + inc;
        await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'poor', cur, maxv);
      }
    } catch (e) {
      console.warn('[AI v2] Failed to update population bucket after building:', e && e.message);
    }

  await client.query('COMMIT');
  recordMetric('actionsExecuted', 1); recordMetric('successfulBuilds', 1);
  // Clear memory for any resources this building produces (we just added capacity/production)
  try {
    const prodKey = (function(bid) {
      try {
        const pk = (function() {
          if (!bid) return null;
          const prodRatesAllLocal = gameUtils.PRODUCTION_RATES || {};
          if (prodRatesAllLocal[bid]) return bid;
          const lower = bid.toString().toLowerCase();
          if (prodRatesAllLocal[lower]) return lower;
          // small map similar to resolveProdKey
          const m = { 'aserradero':'sawmill','cantera':'quarry','granja':'farm','casa_de_piedra':'house','casa_de_ladrillos':'house','casa':'house' };
          return (m[lower] && prodRatesAllLocal[m[lower]]) ? m[lower] : null;
        })();
        return pk;
      } catch (e) { return null; }
    })(buildingId);
    if (prodKey) {
      const rates = (gameUtils.PRODUCTION_RATES || {})[prodKey] || {};
      const producedResources = Object.keys(rates || {}).map(k => k.toString().toLowerCase());
      if (producedResources.length > 0) {
        try { clearMissingResourcesFromMemory(entityId, producedResources); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
  logEvent({ type: 'build', action: 'complete', entityId, buildingId });
  return { success: true, built: buildingId };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (er) { /* ignore */ }
  recordMetric('failedActions', 1);
  logEvent({ type: 'build', action: 'failed', entityId, buildingId, err: e && e.message });
  return { success: false, reason: 'exception', err: e && e.message };
  } finally {
    try { client.release(); } catch (ee) { /* ignore */ }
  }
}

async function runCityTick(poolOrClient, cityId, options = {}) {
  const pool = poolOrClient;
  const opts = Object.assign({ pAct: 0.4, maxTradesPerTick: DEFAULTS.MAX_TRADES_PER_TICK, maxNeighbors: DEFAULTS.MAX_NEIGHBORS }, options || {});

  // Probabilistic gate
  if (Math.random() > (opts.pAct || 0.4)) {
    console.debug(`[AI v2] Skipping city ${cityId} due to pAct`);
    return { success: true, skipped: true };
  }

  // Perceive
  let perception;
  try {
    perception = await perceiveSnapshot(pool, cityId, { maxNeighbors: opts.maxNeighbors });
  } catch (e) {
    console.error('[AI v2] perceiveSnapshot failed for', cityId, e && e.message);
    return { success: false, error: 'perceive_failed' };
  }

  recordMetric('ticksRun', 1);
  recordMetric('citiesProcessed', 1);
  metrics.lastRunAt = Date.now();

  // Plan trades
  const tradeActions = tradePlanner(perception, { maxTradesPerTick: opts.maxTradesPerTick, baseBuyDiv: opts.baseBuyDiv, baseSellDiv: opts.baseSellDiv });
  // Plan builds
  let buildPlannerResult = { candidates: [] };
  try {
    buildPlannerResult = await buildPlanner(perception, pool, {});
  } catch (e) {
    console.warn('[AI v2] buildPlanner failed for', cityId, e && e.message);
    buildPlannerResult = { candidates: [] };
  }

  // buildPlannerResult: { candidates: [...], rejectedDueToPopCount: N, houseCandidate }
  const buildCandidates = buildPlannerResult && buildPlannerResult.candidates ? buildPlannerResult.candidates : [];

  // Helper to compute deficit/surplus summary for common resources (used for logging before builds)
  async function computeCommonDeficitSummary() {
    try {
      const bRows = await getBuildings(perception.entityId);
      let totalPop = 0;
      try {
        const popRows = await populationService.getPopulationRowsWithClient(pool, perception.entityId);
        for (const k of Object.keys(popRows || {})) totalPop += Number(popRows[k].current || 0);
      } catch (e) { totalPop = 0; }
      const prodPerTick = gameUtils.calculateProduction(bRows, { current_population: totalPop }) || {};
      const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
      const cats = gameUtils.RESOURCE_CATEGORIES || {};
      const commonKeys = Object.keys(cats).filter(k => cats[k] === 'common');
      const factor = 60 / (gameUtils.TICK_SECONDS || 60);
      const summary = {};
      for (const res of commonKeys) {
        const stock = Number((perception.inventory && perception.inventory[res]) || 0);
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

  // Decision: choose the top candidate between best build (low payback) and best trade (high score)
  // We'll prioritize builds that address deficits for population maintenance per-bucket: poor(common) -> burgess(processed) -> patrician(specialized)
  const BASE_PREF = ['sawmill', 'quarry', 'farm'];
  let bestBuild = null;
  if (buildCandidates && buildCandidates.length > 0) {
    // try to find a base pref candidate among top few
    const topSlice = buildCandidates.slice(0, 10);

    // 1) Prioritize AI memory-missing resources first (as before)
    const missing = Array.from(getMissingResourcesFromMemory(cityId));
    if (missing && missing.length > 0) {
      const prodMatch = topSlice.find(c => c.produces && c.produces.some(p => missing.includes(p)));
      if (prodMatch) { bestBuild = prodMatch; }
    }

    // 2) Compute deficits grouped by population bucket using production net and current inventory
    if (!bestBuild) {
      try {
        const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
        // load buildings and population snapshot to estimate production
        const bRows = await getBuildings(perception.entityId);
        // sum current population across buckets
        let totalPop = 0;
        try {
          const popRows = await populationService.getPopulationRowsWithClient(pool, cityId);
          for (const k of Object.keys(popRows || {})) totalPop += Number(popRows[k].current || 0);
        } catch (e) { totalPop = 0; }
        const prodPerTick = gameUtils.calculateProduction(bRows, { current_population: totalPop }) || {};

        // bucket mapping helper
        const categoryMap = gameUtils.RESOURCE_CATEGORIES || {};
        function resourceBucketForResource(r) {
          const cat = categoryMap[r] || null;
          if (cat === 'common') return 'poor';
          if (cat === 'processed') return 'burgess';
          if (cat === 'specialized') return 'patrician';
          return null;
        }

        // gather deficits per bucket
  const deficits = { poor: new Set(), burgess: new Set(), patrician: new Set() };
  // helper to iterate object keys when perception.inventory may be sparse
  function rowsOrKeys(obj) { try { return Object.keys(obj || {}); } catch (e) { return []; } }
  const keys = new Set([...rowsOrKeys(perception.inventory || {}), ...Object.keys(prodPerTick || {})]);
        for (const res of keys) {
          if (!res || res === 'gold') continue;
          const cur = Number(perception.inventory[res] || 0);
          const net = Number(prodPerTick[res] || 0);
          if (net < 0 || cur < SAFETY) {
            const bucket = resourceBucketForResource(res);
            if (bucket) deficits[bucket].add(res);
          }
        }

        // If there are deficits in 'poor' resources, apply hybrid policy:
        // 1) If rejectedDueToPopCount > 0 and there is a houseCandidate -> attempt house first
        // 2) Otherwise, attempt to find a producer chain for the poor resources and try to build the first element
        const poorDeficit = (deficits.poor || new Set());
        if (poorDeficit.size > 0) {
          try {
            const rejectedN = (buildPlannerResult && buildPlannerResult.rejectedDueToPopCount) || 0;
            const houseCand = (buildPlannerResult && buildPlannerResult.houseCandidate) || null;
            if (rejectedN > 0 && houseCand) {
              // log common resource deficit summary before attempting to build house
              const commonSummaryBeforeHouse = await computeCommonDeficitSummary();
              logEvent({ type: 'build_attempt_house_due_to_poor_deficit', entityId, reason: 'poor_deficit_and_no_pop_slots', poorDeficit: Array.from(poorDeficit), rejectedN, house: houseCand.buildingId, commonSummary: commonSummaryBeforeHouse });
              try {
                const hres = await executeBuildAction(pool, houseCand, perception, {});
                execResults.push({ action: { type: 'build', building: houseCand.buildingId }, result: hres });
                if (hres && hres.success) {
                  return { success: true, cityId, acted: true, results: execResults };
                }
              } catch (e) {
                logEvent({ type: 'build_attempt_house_failed', entityId, err: e && e.message });
              }
            }

            // If we didn't build a house, try to resolve poor deficits via producer chains
            // Build runtime map and population calc snapshot
            const bRowsForChain = await getBuildings(perception.entityId);
            const runtimeBuildingsForChain = {};
            bRowsForChain.forEach(b => { runtimeBuildingsForChain[b.type] = b.level || 0; });
            let calc = {};
            try { calc = await populationService.calculateAvailablePopulation(perception.entityId); } catch (e) { calc = {}; }

            for (const res of Array.from(poorDeficit)) {
              try {
                const chain = findProducerChain(res, { currentResources: perception.inventory || {}, runtimeBuildings: runtimeBuildingsForChain, calc, maxDepth: opts.maxDepth || 4 });
                if (Array.isArray(chain) && chain.length > 0) {
                  const first = chain[0];
                  logEvent({ type: 'build_producer_chain_found_poor', entityId, missing: res, chain });
                  // try to locate a matching candidate from planner results
                  let alt = (buildCandidates || []).find(c => c.buildingId === first && c.hasCapacity);
                  if (!alt) {
                    const curLevel = runtimeBuildingsForChain[first] || 0;
                    const prodReqs = calculateUpgradeRequirementsFromConstants(first, curLevel);
                    if (prodReqs) {
                      // basic population availability check
                      const bucket = mapBuildingToPopulationBucket(first);
                      let perTypeRow = null;
                      try {
                        const tmpClient = await pool.connect();
                        try {
                          perTypeRow = await populationService.getPopulationByTypeWithClient(tmpClient, perception.entityId, bucket);
                        } finally { tmpClient.release(); }
                      } catch (e) { perTypeRow = null; }
                      const perTypeAvailable = perTypeRow ? Number(perTypeRow.available || Math.max(0, Number(perTypeRow.max || 0) - Number(perTypeRow.current || 0))) : Infinity;
                      const popNeeded = (prodReqs.popForNextLevel || 0) - (prodReqs.currentPopRequirement || 0);
                      const hasCapacity = (perTypeAvailable === Infinity) ? true : (perTypeAvailable >= popNeeded);
                      alt = { buildingId: first, reqs: prodReqs, hasCapacity, produces: Object.keys((gameUtils.PRODUCTION_RATES || {})[first] || {}) };
                    }
                  }
                  if (alt) {
                    // log common resource deficit summary before attempting alternative producer build
                    const commonSummaryBeforeAlt = await computeCommonDeficitSummary();
                    logEvent({ type: 'build_try_alternative_chain_poor', entityId: cityId, alternative: alt.buildingId, missing: res, chain, commonSummary: commonSummaryBeforeAlt });
                    const ares = await executeBuildAction(pool, alt, perception, {});
                    execResults.push({ action: { type: 'build', building: alt.buildingId }, result: ares });
                    if (ares && ares.success) return { success: true, cityId, acted: true, results: execResults };
                  }
                }
              } catch (chainErr) {
                logEvent({ type: 'build_producer_chain_error_poor', entityId, missing: res, err: chainErr && chainErr.message });
              }
            }
          } catch (e) {
            // ignore and fallback to normal bucket selection
            logEvent({ type: 'build_poor_deficit_handling_error', entityId, err: e && e.message });
          }
        }

        // choose candidate by bucket priority
        const bucketOrder = [ 'poor', 'burgess', 'patrician' ];
        for (const bk of bucketOrder) {
          if ((deficits[bk] || new Set()).size === 0) continue;
          // find first candidate producing any resource in this bucket
          const match = (buildCandidates || []).find(c => c.produces && c.produces.some(p => deficits[bk].has(p)));
          if (match) { bestBuild = match; break; }
        }
      } catch (e) {
        // ignore and fallback to base pref
      }
    }

    // 3) fallback: base preference or top candidate
    if (!bestBuild) {
      const basePick = topSlice.find(c => BASE_PREF.includes(c.buildingId));
      if (basePick) bestBuild = basePick;
      else bestBuild = buildCandidates[0];
    }
  }
  const bestTrade = (tradeActions && tradeActions.length > 0) ? tradeActions[0] : null;

  // Helper: check if building a house-type is allowed based on equality of current vs max for the target bucket
  async function isHouseBuildAllowed(poolRef, entityId, buildingIdLocal) {
    if (!buildingIdLocal) return true;
    const lower = buildingIdLocal.toString().toLowerCase();
    // map building to bucket that should trigger house construction
    let bucketToCheck = null;
    if (lower === 'house' || lower === 'house' || lower === 'casa') bucketToCheck = 'poor';
    else if (lower === 'casa_de_piedra' || lower.includes('piedra')) bucketToCheck = 'burgess';
    else if (lower === 'casa_de_ladrillos' || lower.includes('ladrill')) bucketToCheck = 'patrician';
    // if it's not one of these special house types, allow
    if (!bucketToCheck) return true;
    try {
      const populationServiceLocal = require('../utils/populationService');
      const client = await poolRef.connect();
      try {
        const row = await populationServiceLocal.getPopulationByTypeWithClient(client, entityId, bucketToCheck);
        const cur = Number(row.current || 0);
        const maxv = Number(row.max || 0);
        return cur === maxv;
      } finally {
        client.release();
      }
    } catch (e) {
      return false; // if we can't verify, be conservative and disallow
    }
  }

  const execResults = [];

  // Simple policy: If bestBuild exists and has payback < threshold (e.g., 200) and hasCapacity, prefer build.
  const PAYBACK_THRESHOLD = opts.paybackThreshold || 200;
  // Override boost threshold: if a candidate has priorityBoost >= this, ignore payback limits
  const OVERRIDE_PRIORITY_BOOST = typeof opts.overridePriorityBoost === 'number' ? opts.overridePriorityBoost : 8;

  // helper: decide effective threshold for a candidate based on urgency (priorityBoost or low inventory)
  function computeEffectiveThresholdForCandidate(candidate) {
    const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
    if (!candidate) return PAYBACK_THRESHOLD;
    // if explicit high priority boost, override
    if ((candidate.priorityBoost || 0) >= OVERRIDE_PRIORITY_BOOST) return Infinity;
    // if candidate produces a resource we are low on, override
    try {
      const produces = candidate.produces || [];
      for (const r of produces) {
        const have = Number(perception.inventory && perception.inventory[r] || 0);
        if (have < SAFETY) return Infinity;
      }
    } catch (e) { /* ignore */ }
    return PAYBACK_THRESHOLD;
  }
  if (bestBuild) {
    // If bestBuild is a house-type, only allow it when the corresponding bucket's current == max
    const isHouseBest = bestBuild.buildingId === 'house' || bestBuild.buildingId.startsWith('casa') || bestBuild.buildingId.startsWith('house');
    if (isHouseBest) {
      const allowed = await isHouseBuildAllowed(pool, cityId, bestBuild.buildingId);
      if (!allowed) {
        logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'house_not_needed_per_bucket', candidate: bestBuild });
        // treat as skipped; do not proceed to build
        // Note: we still allow other non-house candidates to be considered below
      } else if (!bestBuild.hasCapacity) {
        // Re-check population under a transaction to avoid inconsistent reads
        let recheckedHasCapacity = false;
        try {
          const populationServiceLocal = require('../utils/populationService');
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [cityId]);
            const prow = await populationServiceLocal.getPopulationByTypeWithClient(client, cityId, bestBuild.bucket || mapBuildingToPopulationBucket(bestBuild.buildingId));
            const cur = Number(prow.current || 0);
            const maxv = Number(prow.max || 0);
            const available = Number(prow.available !== undefined ? prow.available : Math.max(0, maxv - cur));
            const popNeededForThisBuild = ((bestBuild.reqs && bestBuild.reqs.popForNextLevel) ? Number(bestBuild.reqs.popForNextLevel) : 0) - ((bestBuild.reqs && bestBuild.reqs.currentPopRequirement) ? Number(bestBuild.reqs.currentPopRequirement) : 0);
            await client.query('COMMIT');
            recheckedHasCapacity = (available >= popNeededForThisBuild) || (bestBuild.buildingId === 'house' || bestBuild.buildingId.startsWith('casa'));
            if (!recheckedHasCapacity) logEvent({ type: 'build_decision_skip_recheck', entityId: cityId, reason: 'no_capacity_after_recheck', candidate: bestBuild, recheck: { current: cur, max: maxv, available, popNeededForThisBuild } });
          } catch (reErr) {
            try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
          } finally { try { client.release(); } catch (e) { /* ignore */ } }
        } catch (e) {
          // ignore recheck errors — fall back to original decision
        }
        if (!recheckedHasCapacity) {
          logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'no_capacity', candidate: bestBuild });
        } else {
          // allow build to proceed by marking capacity true
          bestBuild.hasCapacity = true;
        }
      } else {
        const effectiveThreshold = computeEffectiveThresholdForCandidate(bestBuild);
        if (bestBuild.payback > effectiveThreshold) {
          logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'payback_too_high', payback: bestBuild.payback, threshold: effectiveThreshold, candidate: bestBuild });
        }
      }
    } else {
      if (!bestBuild.hasCapacity) {
        // Re-check population under a transaction to avoid inconsistent reads
        let recheckedHasCapacity = false;
        try {
          const populationServiceLocal = require('../utils/populationService');
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM populations WHERE entity_id = $1 FOR UPDATE', [cityId]);
            const prow = await populationServiceLocal.getPopulationByTypeWithClient(client, cityId, bestBuild.bucket || mapBuildingToPopulationBucket(bestBuild.buildingId));
            const cur = Number(prow.current || 0);
            const maxv = Number(prow.max || 0);
            const available = Number(prow.available !== undefined ? prow.available : Math.max(0, maxv - cur));
            const popNeededForThisBuild = ((bestBuild.reqs && bestBuild.reqs.popForNextLevel) ? Number(bestBuild.reqs.popForNextLevel) : 0) - ((bestBuild.reqs && bestBuild.reqs.currentPopRequirement) ? Number(bestBuild.reqs.currentPopRequirement) : 0);
            await client.query('COMMIT');
            recheckedHasCapacity = (available >= popNeededForThisBuild);
            if (!recheckedHasCapacity) logEvent({ type: 'build_decision_skip_recheck', entityId: cityId, reason: 'no_capacity_after_recheck', candidate: bestBuild, recheck: { current: cur, max: maxv, available, popNeededForThisBuild } });
          } catch (reErr) {
            try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
          } finally { try { client.release(); } catch (e) { /* ignore */ } }
        } catch (e) {
          // ignore recheck errors — fall back to original decision
        }
        if (!recheckedHasCapacity) {
          logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'no_capacity', candidate: bestBuild });
        } else {
          // allow build to proceed by marking capacity true
          bestBuild.hasCapacity = true;
        }
      } else {
        const effectiveThreshold = computeEffectiveThresholdForCandidate(bestBuild);
        if (bestBuild.payback > effectiveThreshold) {
          logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'payback_too_high', payback: bestBuild.payback, threshold: effectiveThreshold, candidate: bestBuild });
        }
      }
    }
  }

  // compute effective threshold for chosen bestBuild (used below to decide whether to proceed)
  const effectiveThresholdForBest = bestBuild ? computeEffectiveThresholdForCandidate(bestBuild) : PAYBACK_THRESHOLD;

  if (bestBuild && bestBuild.hasCapacity && bestBuild.payback <= effectiveThresholdForBest) {
    // attempt build
    // If there are clear deficits or low-stock resources, try to pick a candidate
    // that produces them even if it's not the top payback candidate.
    let chosenBuild = bestBuild;
    try {
      const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
      // find resources with projected deficit or below safety
      const urgentResources = [];
      // compute production per tick using real population snapshot (not 0)
      let prodSnapshot = {};
      try {
        const bRowsForUrgent = await getBuildings(perception.entityId);
        // sum current population across buckets
        let totalPopUrg = 0;
        try {
          const popRowsUrg = await populationService.getPopulationRowsWithClient(pool, perception.entityId);
          for (const k of Object.keys(popRowsUrg || {})) totalPopUrg += Number(popRowsUrg[k].current || 0);
        } catch (e) { totalPopUrg = 0; }
        prodSnapshot = gameUtils.calculateProduction(bRowsForUrgent, { current_population: totalPopUrg }) || {};
      } catch (e) { prodSnapshot = {}; }

      for (const r of Object.keys(perception.inventory || {})) {
        if (r === 'gold') continue;
        const cur = Number(perception.inventory[r] || 0);
        const netPerTick = Number(prodSnapshot[r] || 0);
        if (netPerTick < 0) urgentResources.push(r);
        else if (cur < SAFETY) urgentResources.push(r);
      }
      if (urgentResources.length > 0) {
        // look for a candidate producing any urgent resource and with capacity
        // Prefer candidates in the same population bucket as the bestBuild (avoid jumping buckets unexpectedly)
        const bucketPref = (bestBuild && bestBuild.bucket) ? bestBuild.bucket : null;
        let alt = null;
        if (bucketPref) {
          alt = (buildCandidates || []).find(c => c.hasCapacity && c.bucket === bucketPref && c.produces && c.produces.some(p => urgentResources.includes(p)));
        }
        if (!alt) {
          alt = (buildCandidates || []).find(c => c.hasCapacity && c.produces && c.produces.some(p => urgentResources.includes(p)));
        }
        if (alt) chosenBuild = alt;
      }
    } catch (e) {
      // ignore and proceed with bestBuild
    }

  // Log common deficit/surplus summary immediately before attempting the chosen build
  try {
    const commonSummaryBeforeBuild = await computeCommonDeficitSummary();
    logEvent({ type: 'build_chosen_common_summary', entityId: cityId, chosen: (chosenBuild && chosenBuild.buildingId) || (bestBuild && bestBuild.buildingId), commonSummary: commonSummaryBeforeBuild });
  } catch (e) { /* ignore logging errors */ }

  const bres = await executeBuildAction(pool, chosenBuild, perception, {});
  execResults.push({ action: { type: 'build', building: (chosenBuild && chosenBuild.buildingId) || (bestBuild && bestBuild.buildingId) }, result: bres });
    if (bres && bres.success) return { success: true, cityId, acted: true, results: execResults };
    // if build failed, try to prioritize building a producer of the missing resource (if that was the reason)
    if (bres && bres.success === false && bres.reason === 'insufficient_resources' && bres.resource) {
      const missing = bres.resource;
      logEvent({ type: 'build_missing_resource', entityId: cityId, missing });
      // First: attempt to BUY the missing resource via market even if market price is high
      try {
        const wantQty = Number(bres.need || 1) || 1;
        // Attempt forced buy: find any neighbor with stock > 0 and execute trade
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          let sellerId = null;
          for (const nb of perception.neighbors || []) {
            try {
              const nInv = await resourcesService.getResourcesWithClient(client, nb.id);
              const sellerStock = Number(nInv && nInv[missing] || 0);
              if (sellerStock > 0) { sellerId = nb.id; break; }
            } catch (e) {
              // ignore per-neighbor failures
            }
          }
          if (sellerId) {
            const mp = await marketService.computeMarketPriceSingle(client, missing, wantQty, 'buy');
            if (mp && typeof mp.price !== 'undefined') {
              try {
                const snapshot = await marketService.tradeWithClient(client, perception.entityId, sellerId, missing, mp.price, wantQty);
                await client.query('COMMIT');
                recordMetric('actionsExecuted', 1); recordMetric('successfulTrades', 1);
                logEvent({ type: 'forced_buy', entityId: perception.entityId, missing, qty: wantQty, price: mp.price, sellerId });
                execResults.push({ action: { type: 'forced_buy', resource: missing, qty: wantQty }, success: true, snapshot });
                // success — clear missing from AI memory and return early
                try { clearMissingResourcesFromMemory(perception.entityId, [missing]); } catch (e) {}
                return { success: true, cityId, acted: true, results: execResults };
              } catch (tradeErr) {
                try { await client.query('ROLLBACK'); } catch (e) {}
                logEvent({ type: 'forced_buy_failed_trade', entityId: perception.entityId, missing, err: tradeErr && tradeErr.message });
              }
            } else {
              await client.query('ROLLBACK');
            }
          } else {
            await client.query('ROLLBACK');
          }
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (er) {}
        } finally {
          try { client.release(); } catch (er) {}
        }
      } catch (e) {
        // ignore forced-buy errors and fall back to existing alt-build logic
        logEvent({ type: 'forced_buy_error', entityId: perception.entityId, missing, err: e && e.message });
      }

      // If forced buy didn't succeed, attempt a recursive search for a producer chain for the missing resource
      try {
        // build runtimeBuildings map
        const bRows = await getBuildings(perception.entityId);
        const runtimeBuildings = {};
        bRows.forEach(b => { runtimeBuildings[b.type] = b.level || 0; });
        // compute population availability snapshot
        let calc = {};
        try { calc = await populationService.calculateAvailablePopulation(perception.entityId); } catch (e) { calc = {}; }

        const chain = findProducerChain(missing, { currentResources: perception.inventory || {}, runtimeBuildings, calc, maxDepth: 4 });
        if (Array.isArray(chain) && chain.length > 0) {
          const first = chain[0];
          logEvent({ type: 'build_producer_chain_found', entityId: cityId, missing, chain });
          // try to locate a matching candidate from planner results
          let alt = (buildCandidates || []).find(c => c.buildingId === first && c.hasCapacity);
          if (!alt) {
            // construct a minimal candidate object if planner didn't include it
            const curLevel = runtimeBuildings[first] || 0;
            const prodReqs = calculateUpgradeRequirementsFromConstants(first, curLevel);
            if (prodReqs) {
              // basic population availability check
              const bucket = mapBuildingToPopulationBucket(first);
              let perTypeRow = null;
              try {
                const tmpClient = await pool.connect();
                try {
                  perTypeRow = await populationService.getPopulationByTypeWithClient(tmpClient, perception.entityId, bucket);
                } finally { tmpClient.release(); }
              } catch (e) { perTypeRow = null; }
              const perTypeAvailable = perTypeRow ? Number(perTypeRow.available || Math.max(0, Number(perTypeRow.max || 0) - Number(perTypeRow.current || 0))) : Infinity;
              const popNeeded = (prodReqs.popForNextLevel || 0) - (prodReqs.currentPopRequirement || 0);
              const hasCapacity = (perTypeAvailable === Infinity) ? true : (perTypeAvailable >= popNeeded);
              alt = { buildingId: first, reqs: prodReqs, hasCapacity, produces: Object.keys((gameUtils.PRODUCTION_RATES || {})[first] || {}) };
            }
          }
          if (alt) {
            logEvent({ type: 'build_try_alternative_chain', entityId: cityId, original: bestBuild && bestBuild.buildingId, alternative: alt.buildingId, missing, chain });
            const ares = await executeBuildAction(pool, alt, perception, {});
            execResults.push({ action: { type: 'build', building: alt.buildingId }, result: ares });
            if (ares && ares.success) return { success: true, cityId, acted: true, results: execResults };
          }
        }
      } catch (chainErr) {
        logEvent({ type: 'build_producer_chain_error', entityId: cityId, missing, err: chainErr && chainErr.message });
      }
    }
  }

  // If no builds were executed and there were candidates rejected due to population shortage, attempt to build a house to increase capacity
  try {
    const rejectedN = (buildPlannerResult && buildPlannerResult.rejectedDueToPopCount) || 0;
    const houseCand = (buildPlannerResult && buildPlannerResult.houseCandidate) || null;
    if ((!bestBuild || !bestBuild.hasCapacity || (bestBuild && bestBuild.payback > PAYBACK_THRESHOLD)) && rejectedN > 0 && houseCand) {
      // Only attempt to build a house if the specific bucket is at capacity (we actually need that capacity)
      const allowedHouseAttempt = await isHouseBuildAllowed(pool, cityId, houseCand.buildingId);
      if (allowedHouseAttempt) {
        logEvent({ type: 'build_attempt_house_for_capacity', entityId: cityId, reason: 'no_pop_slots', rejected: rejectedN, house: houseCand.buildingId });
        const hres = await executeBuildAction(pool, houseCand, perception, {});
        execResults.push({ action: { type: 'build', building: houseCand.buildingId }, result: hres });
        if (hres && hres.success) return { success: true, cityId, acted: true, results: execResults };
      } else {
        logEvent({ type: 'build_attempt_house_skipped_not_full', entityId: cityId, reason: 'not_at_capacity_per_bucket', house: houseCand && houseCand.buildingId });
      }
    }
  } catch (e) {
    // ignore failures here
  }

  // Execute trades (fallback or if no good build)
  for (const a of tradeActions) {
    try {
      const res = await executeTradeAction(pool, a, perception, { baseBuyDiv: opts.baseBuyDiv, safetyStock: opts.safetyStock, profitMargin: opts.profitMargin });
      execResults.push(Object.assign({ action: a }, res));
      if (res.success) break; // do at most one successful action per tick to be conservative
    } catch (e) {
      execResults.push({ action: a, success: false, err: e && e.message });
    }
  }

  const acted = execResults.some(r => r.success || (r.result && r.result.success));
  // Compute wood production and consumption per minute for logging
  let woodProducedPerMinute = null;
  let woodConsumedPerMinute = null;
  try {
    const buildingRows = await getBuildings(cityId);
    // sum current population across buckets
    let totalPop = 0;
    try {
      const popRows = await populationService.getPopulationRowsWithClient(pool, cityId);
      for (const k of Object.keys(popRows || {})) {
        totalPop += Number(popRows[k].current || 0);
      }
    } catch (e) {
      totalPop = 0;
    }
    const prodPerTick = gameUtils.calculateProduction(buildingRows, { current_population: totalPop }) || {};
    const woodPerTick = Number(prodPerTick.wood || 0);
    const factor = 60 / (gameUtils.TICK_SECONDS || 60);
    woodProducedPerMinute = Math.max(0, woodPerTick) * factor;
    woodConsumedPerMinute = Math.max(0, -woodPerTick) * factor;
  } catch (e) {
    // leave null on failure
    woodProducedPerMinute = null;
    woodConsumedPerMinute = null;
  }

  logEvent({ type: 'city_tick_summary', entityId: cityId, acted, results: execResults, wood_produced_per_minute: woodProducedPerMinute, wood_consumed_per_minute: woodConsumedPerMinute });
  return { success: true, cityId, acted, results: execResults, wood_produced_per_minute: woodProducedPerMinute, wood_consumed_per_minute: woodConsumedPerMinute };
}

async function runBatch(pool, options = {}) {
  options = Object.assign({ maxCitiesPerTick: 40, concurrency: 6, runPercent: 0, maxNeighbors: DEFAULTS.MAX_NEIGHBORS }, options || {});
  console.debug('[AI v2] runBatch starting with options:', options);
  const rows = await aiCityService.listCities(pool, false);
  const candidates = (rows || []).slice(0, options.maxCitiesPerTick || 40);
  console.debug(`[AI v2] Candidate cities: ${candidates.length}`);
  const results = [];
  for (const c of candidates) {
    try {
      // decide randomly whether to run v2 for this tick based on runPercent
      const chance = Math.random() * 100;
      if (options.runPercent && options.runPercent > 0 && chance > options.runPercent) {
        results.push({ cityId: c.id, skipped: true });
        continue;
      }
      const entRes = await pool.query('SELECT entity_id FROM ai_cities WHERE id = $1', [c.id]);
      const entityId = entRes.rows[0] && entRes.rows[0].entity_id;
      if (!entityId) { results.push({ cityId: c.id, skipped: true }); continue; }
      const r = await runCityTick(pool, entityId, options);
      results.push(Object.assign({ cityId: c.id }, r));
    } catch (e) {
      console.error('[AI v2] runBatch error for city', c.id, e && e.message);
      results.push({ cityId: c.id, error: e && e.message });
    }
  }
  console.debug('[AI v2] runBatch finished');
  // log metrics summary
  logEvent({ type: 'batch_summary', candidates: candidates.length, resultsCount: results.length, metrics: getMetrics() });
  return results;
}

module.exports = { runBatch, runCityTick };

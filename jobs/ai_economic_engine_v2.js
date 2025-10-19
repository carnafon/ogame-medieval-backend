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
  try { console.log('[AI v2][event] ' + JSON.stringify(event)); } catch (e) { console.log('[AI v2][event] (could not stringify)'); }
}

// Perception: snapshot of entity inventory, coords, and price_base map
async function perceiveSnapshot(pool, entityId, opts = {}) {
  const client = pool;
  // load coords
  const entRowRes = await client.query('SELECT x_coord, y_coord FROM entities WHERE id = $1', [entityId]);
  const entRow = entRowRes.rows[0] || {};
  const x = entRow.x_coord || 0;
  const y = entRow.y_coord || 0;

  // load inventory
  const invRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`, [entityId]);
  const inventory = Object.fromEntries(invRes.rows.map(r => [r.name, parseInt(r.amount, 10) || 0]));

  // load price_base map
  const ptRes = await client.query('SELECT lower(name) as name, price_base FROM resource_types');
  const priceBaseMap = {};
  for (const r of ptRes.rows) priceBaseMap[r.name] = Number(r.price_base) || 1;

  // find nearby AI city entities (limited)
  const nbRes = await client.query(
    `SELECT e.id, e.x_coord, e.y_coord FROM entities e WHERE e.type = 'cityIA' AND e.id <> $1 LIMIT $2`,
    [entityId, opts.maxNeighbors || DEFAULTS.MAX_NEIGHBORS]
  );
  const neighbors = (nbRes.rows || []).map(r => ({ id: r.id, x: r.x_coord, y: r.y_coord }));

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
        const nRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1 AND lower(rt.name) = $2`, [nb.id, resource]);
        const neighborAmt = (nRes.rows[0] && parseInt(nRes.rows[0].amount, 10)) || 0;
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
        const nRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1 AND lower(rt.name) = $2`, [nb.id, resource]);
        const sellerStock = (nRes.rows[0] && parseInt(nRes.rows[0].amount, 10)) || 0;
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
  const requiredCost = {
    wood: Math.ceil((costBase.wood || 0) * Math.pow(nextLevel, factor)),
    stone: Math.ceil((costBase.stone || 0) * Math.pow(nextLevel, factor)),
    food: Math.ceil((costBase.food || 0) * Math.pow(nextLevel, factor)),
  };
  const popNeeded = typeof costBase.popNeeded === 'number' ? costBase.popNeeded : (buildingType === 'house' ? 0 : 1);
  return {
    nextLevel,
    requiredCost,
    requiredTimeS: 0,
    popForNextLevel: popNeeded,
    currentPopRequirement: 0
  };
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

  // compute population stats for consumption
  let populationStats = { current_population: 0 };
  try {
    const prow = await pool.query('SELECT type, current_population, max_population FROM populations WHERE entity_id = $1', [entityId]);
    if (prow.rows && prow.rows.length > 0) {
      let total = 0;
      prow.rows.forEach(r => { total += Number(r.current_population || 0); });
      populationStats.current_population = total;
    }
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
    const rates = prodRatesAll[buildingId] || {};
    let rawValueSum = 0;
    for (const res of Object.keys(rates)) {
      const rate = Number(rates[res]) || 0;
      const base = priceBaseMap[res] || 1;
      rawValueSum += rate * base; // per level estimate
    }
    if (rawValueSum <= 0) {
      // include a concise perceiveSnapshot value for debugging
      const perceptionSnapshotForLog = {
        inventory: perception && perception.inventory ? perception.inventory : {},
        priceBaseMap: perception && perception.priceBaseMap ? perception.priceBaseMap : {},
        x: perception && typeof perception.x !== 'undefined' ? perception.x : null,
        y: perception && typeof perception.y !== 'undefined' ? perception.y : null,
        neighborsCount: perception && perception.neighbors ? perception.neighbors.length : 0
      };
      logEvent({ type: 'build_candidate_skipped', entityId, buildingId, reason: 'no_production_value', valueSum: rawValueSum, priceBaseMap, perception: perceptionSnapshotForLog });
      continue; // skip non-producer buildings for now
    }

    // Adjust valueSum based on current stock and consumption urgency
    let adjustedValueSum = rawValueSum;
    try {
      const SAFETY = opts.safetyStock || DEFAULTS.SAFETY_STOCK;
      const multiplierParts = [];
      for (const res of Object.keys(rates)) {
        const produces = Number(rates[res]) || 0;
        // projected net production over horizon
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
      // fallback to raw value
      adjustedValueSum = rawValueSum;
    }

    const payback = costGold / Math.max(1, adjustedValueSum);

    // determine target population bucket and simple population check (current < max)
    const bucket = mapBuildingToPopulationBucket(buildingId);
    let perTypeMax = null;
    let perTypeCurrent = null;
    try {
      const prow = await pool.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, bucket]);
      if (prow.rows.length > 0) {
        perTypeCurrent = Number(prow.rows[0].current_population || 0);
        perTypeMax = Number(prow.rows[0].max_population || 0);
      }
    } catch (e) {
      perTypeMax = null;
    }

    const hasCapacity = (perTypeMax === null) || (perTypeCurrent < perTypeMax) || buildingId.startsWith('house') || buildingId === 'house';

    candidates.push({ buildingId, currentLevel, reqs, costGold, valueSum: rawValueSum, adjustedValueSum, payback, bucket, hasCapacity });
  }

  // prefer candidates with hasCapacity true and lower payback
  candidates.sort((a, b) => {
    if (a.hasCapacity !== b.hasCapacity) return a.hasCapacity ? -1 : 1;
    return a.payback - b.payback;
  });

  if (!candidates || candidates.length === 0) {
    logEvent({ type: 'build_planner_no_candidates', entityId, reason: 'no_viable_candidates', priceBaseMap });
  } else {
    logEvent({ type: 'build_planner_candidates', entityId, count: candidates.length, top: candidates[0] });
  }

  return candidates;
}

// Execute build action atomically: deduct resources, persist building level, and update populations for houses
async function executeBuildAction(pool, candidate, perception, opts = {}) {
  const entityId = perception.entityId;
  const reqs = candidate.reqs;
  const buildingId = candidate.buildingId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // lock resource inventory rows for entity
    await client.query(`SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`, [entityId]);

    // re-check resource amounts
    const invRes = await client.query(`SELECT lower(rt.name) as name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`, [entityId]);
    const currentResources = Object.fromEntries(invRes.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10) || 0]));

    for (const r in reqs.requiredCost) {
      const needAmt = reqs.requiredCost[r] || 0;
      if ((currentResources[r] || 0) < needAmt) {
        // detailed missing resources log
        const have = (currentResources[r] || 0);
        logEvent({ type: 'build_failed_insufficient_resources', entityId, buildingId, resource: r, need: needAmt, have });
        await client.query('ROLLBACK');
        return { success: false, reason: 'insufficient_resources', resource: r, need: needAmt, have };
      }
    }

    // population check: ensure per-type current < max unless building is a house
    const bucket = mapBuildingToPopulationBucket(buildingId);
    if (!(buildingId === 'house' || buildingId.startsWith('casa') || buildingId.startsWith('house'))) {
      const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1 FOR UPDATE', [entityId, bucket]);
      if (prow.rows.length > 0) {
        const cur = Number(prow.rows[0].current_population || 0);
        const maxv = Number(prow.rows[0].max_population || 0);
        if (cur >= maxv) {
          logEvent({ type: 'build_failed_population_capacity', entityId, buildingId, bucket, current: cur, max: maxv });
          await client.query('ROLLBACK');
          return { success: false, reason: 'population_capacity', bucket, current: cur, max: maxv };
        }
      }
    }

    // Deduct resources
    for (const r in reqs.requiredCost) {
      const amount = reqs.requiredCost[r] || 0;
      if (amount <= 0) continue;
      await client.query(`UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE lower(name) = $3)`, [amount, entityId, r.toString().toLowerCase()]);
      logEvent({ type: 'build_deduct_resource', entityId, buildingId, resource: r, amount });
    }

    // Persist building level increment
    const blRes = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, buildingId]);
    if (blRes.rows.length > 0) {
      await client.query('UPDATE buildings SET level = level + 1 WHERE entity_id = $1 AND type = $2', [entityId, buildingId]);
    } else {
      await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,1)', [entityId, buildingId]);
    }

    // If house-type built, update population max bucket
    try {
      const gu = require('../utils/gameUtils');
      const inc = gu.POPULATION_PER_HOUSE || 5;
      if (buildingId === 'casa_de_piedra') {
        const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, 'burgess']);
        if (prow.rows.length > 0) {
          const cur = parseInt(prow.rows[0].current_population || 0, 10);
          const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
          const avail = Math.max(0, maxv - cur);
          await populationService.setPopulationForTypeWithClient(client, entityId, 'burgess', cur, maxv, avail);
        } else {
          await populationService.setPopulationForTypeWithClient(client, entityId, 'burgess', 0, inc, inc);
        }
      } else if (buildingId === 'casa_de_ladrillos') {
        const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, 'patrician']);
        if (prow.rows.length > 0) {
          const cur = parseInt(prow.rows[0].current_population || 0, 10);
          const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
          const avail = Math.max(0, maxv - cur);
          await populationService.setPopulationForTypeWithClient(client, entityId, 'patrician', cur, maxv, avail);
        } else {
          await populationService.setPopulationForTypeWithClient(client, entityId, 'patrician', 0, inc, inc);
        }
      } else if (buildingId === 'house') {
        const prow = await client.query('SELECT current_population, max_population FROM populations WHERE entity_id = $1 AND type = $2 LIMIT 1', [entityId, 'poor']);
        if (prow.rows.length > 0) {
          const cur = parseInt(prow.rows[0].current_population || 0, 10);
          const maxv = parseInt(prow.rows[0].max_population || 0, 10) + inc;
          const avail = Math.max(0, maxv - cur);
          await populationService.setPopulationForTypeWithClient(client, entityId, 'poor', cur, maxv, avail);
        } else {
          await populationService.setPopulationForTypeWithClient(client, entityId, 'poor', 0, inc, inc);
        }
      }
    } catch (e) {
      console.warn('[AI v2] Failed to update population bucket after building:', e && e.message);
    }

  await client.query('COMMIT');
  recordMetric('actionsExecuted', 1); recordMetric('successfulBuilds', 1);
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
    console.log(`[AI v2] Skipping city ${cityId} due to pAct`);
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
  let buildCandidates = [];
  try {
    buildCandidates = await buildPlanner(perception, pool, {});
  } catch (e) {
    console.warn('[AI v2] buildPlanner failed for', cityId, e && e.message);
    buildCandidates = [];
  }

  // Decision: choose the top candidate between best build (low payback) and best trade (high score)
  const bestBuild = (buildCandidates && buildCandidates.length > 0) ? buildCandidates[0] : null;
  const bestTrade = (tradeActions && tradeActions.length > 0) ? tradeActions[0] : null;

  const execResults = [];

  // Simple policy: If bestBuild exists and has payback < threshold (e.g., 200) and hasCapacity, prefer build.
  const PAYBACK_THRESHOLD = opts.paybackThreshold || 200;
  if (bestBuild) {
    if (!bestBuild.hasCapacity) {
      logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'no_capacity', candidate: bestBuild });
    } else if (bestBuild.payback > PAYBACK_THRESHOLD) {
      logEvent({ type: 'build_decision_skip', entityId: cityId, reason: 'payback_too_high', payback: bestBuild.payback, threshold: PAYBACK_THRESHOLD, candidate: bestBuild });
    }
  }

  if (bestBuild && bestBuild.hasCapacity && bestBuild.payback <= PAYBACK_THRESHOLD) {
    // attempt build
    const bres = await executeBuildAction(pool, bestBuild, perception, {});
    execResults.push({ action: { type: 'build', building: bestBuild.buildingId }, result: bres });
    if (bres && bres.success) return { success: true, cityId, acted: true, results: execResults };
    // if build failed, fall back to trades
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
  logEvent({ type: 'city_tick_summary', entityId: cityId, acted, results: execResults });
  return { success: true, cityId, acted, results: execResults };
}

async function runBatch(pool, options = {}) {
  options = Object.assign({ maxCitiesPerTick: 40, concurrency: 6, runPercent: 0, maxNeighbors: DEFAULTS.MAX_NEIGHBORS }, options || {});
  console.log('[AI v2] runBatch starting with options:', options);
  const rows = await aiCityService.listCities(pool, false);
  const candidates = (rows || []).slice(0, options.maxCitiesPerTick || 40);
  console.log(`[AI v2] Candidate cities: ${candidates.length}`);
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
  console.log('[AI v2] runBatch finished');
  // log metrics summary
  logEvent({ type: 'batch_summary', candidates: candidates.length, resultsCount: results.length, metrics: getMetrics() });
  return results;
}

module.exports = { runBatch, runCityTick };

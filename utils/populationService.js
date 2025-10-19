const pool = require('../db');

// Population types we'll use
const POP_TYPES = ['poor', 'burgess', 'patrician'];

/**
 * Initialize population rows for an entity. If a client is provided, uses it.
 * distribution: optional object with amounts per type, otherwise defaults applied.
 */
async function initPopulations(clientOrPool, entityId, distribution = null) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const client = usingClient ? clientOrPool : await pool.connect();
  try {
    if (!usingClient) await client.query('BEGIN');

    // Default distribution: all population placed in 'poor' unless distribution provided
    const defaultTotal = 0; // caller will decide totals; we insert zeros by default
    const dist = distribution || { poor: defaultTotal, burgess: 0, patrician: 0 };

    for (const t of POP_TYPES) {
      const cur = typeof dist[t] === 'number' ? dist[t] : 0;
      const max = cur; // default max equals initial current unless caller provides different logic
      const avail = Math.max(0, max - cur);
      await client.query(
        `INSERT INTO populations (entity_id, type, current_population, max_population, available_population)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (entity_id, type) DO UPDATE SET current_population = EXCLUDED.current_population, max_population = EXCLUDED.max_population, available_population = EXCLUDED.available_population`,
        [entityId, t, cur, max, avail]
      );
    }

    if (!usingClient) await client.query('COMMIT');
    return true;
  } catch (err) {
    if (!usingClient) try { await client.query('ROLLBACK'); } catch (e) {}
    throw err;
  } finally {
    if (!usingClient) client.release();
  }
}

/**
 * Get population totals for an entity: returns { total, max, available, breakdown: { poor, burgess, patrician } }
 * Note: max_population and current_population legacy fields are still in entities for compatibility and should be
 * kept in sync by callers (we'll read them as fallback if needed).
 */
async function getPopulationSummary(entityId) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT type, current_population, max_population, available_population FROM populations WHERE entity_id = $1', [entityId]);
    const breakdown = { poor: 0, burgess: 0, patrician: 0 };
    let total = 0;
    let max = 0;
    let available = 0;
    for (const r of res.rows) {
      const t = (r.type || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(breakdown, t)) continue;
      const cur = parseInt(r.current_population || 0, 10);
      const m = parseInt(r.max_population || 0, 10);
      const a = parseInt(r.available_population || 0, 10);
      breakdown[t] = cur;
      total += cur;
      max += m;
      available += a;
    }

    return { total, max, available, breakdown };
  } finally {
    client.release();
  }
}

// Client-aware version: does not release the client
async function getPopulationSummaryWithClient(client, entityId) {
  const res = await client.query('SELECT type, current_population, max_population, available_population FROM populations WHERE entity_id = $1', [entityId]);
  const breakdown = { poor: 0, burgess: 0, patrician: 0 };
  let total = 0;
  let max = 0;
  let available = 0;
  for (const r of res.rows) {
    const t = (r.type || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(breakdown, t)) continue;
    const cur = parseInt(r.current_population || 0, 10);
    const m = parseInt(r.max_population || 0, 10);
    const a = parseInt(r.available_population || 0, 10);
    breakdown[t] = cur;
    total += cur;
    max += m;
    available += a;
  }
  return { total, max, available, breakdown };
}

// Set population for a specific type using provided client
async function setPopulationForTypeWithClient(client, entityId, type, currentPopulation, maxPopulation, availablePopulation) {
  await client.query(
    `INSERT INTO populations (entity_id, type, current_population, max_population, available_population)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (entity_id, type) DO UPDATE SET current_population = EXCLUDED.current_population, max_population = EXCLUDED.max_population, available_population = EXCLUDED.available_population`,
    [entityId, type, currentPopulation, maxPopulation, availablePopulation]
  );
}

// --- New helpers for occupation/available calculation ---

/**
 * Compute occupation per population bucket from grouped building rows.
 * Input: buildings = [{ type, level, count }, ...] where level and count are strings/numbers from SQL.
 * Rule: occupation contribution = level * count for the building (houses are ignored).
 * The building's produced resources are used to infer which population bucket it consumes:
 *  - 'common' -> 'poor'
 *  - 'processed' -> 'burgess'
 *  - 'specialized' -> 'patrician'
 * We use gameUtils.PRODUCTION_RATES and gameUtils.RESOURCE_CATEGORIES to infer mapping.
 * Returns an object: { poor: number, burgess: number, patrician: number, total: number }
 */
const gameUtils = require('./gameUtils');
function computeOccupationFromBuildings(buildings = []) {
  const occupation = { poor: 0, burgess: 0, patrician: 0 };
  if (!Array.isArray(buildings)) return occupation;

  const prodRates = gameUtils.PRODUCTION_RATES || {};
  const resourceCategories = gameUtils.RESOURCE_CATEGORIES || {};

  for (const b of buildings) {
    if (!b || !b.type) continue;
    const type = (b.type || '').toString();
    if (type === 'house') continue; // houses provide capacity, don't consume population
    const lvl = Number.isFinite(Number(b.level)) ? Number(b.level) : 0;
    const cnt = Number.isFinite(Number(b.count)) ? Number(b.count) : 1;
    if (lvl <= 0 || cnt <= 0) continue;
    const contrib = lvl * cnt;

    // determine building category by inspecting what it produces
    const rates = prodRates[type] || {};
    let mapped = null;
    for (const res of Object.keys(rates)) {
      const cat = resourceCategories[res];
      if (!cat) continue;
      if (cat === 'common') { mapped = 'poor'; break; }
      if (cat === 'processed') { mapped = 'burgess'; break; }
      if (cat === 'specialized') { mapped = 'patrician'; break; }
    }

    // fallback: if no produced resource found, try heuristics by name
    if (!mapped) {
      if (type.includes('well') || type.includes('farm') || type.includes('sawmill') || type.includes('quarry')) mapped = 'poor';
      else if (type.includes('carpinter') || type.includes('fabrica') || type.includes('alfareria') || type.includes('tintoreria')) mapped = 'burgess';
      else mapped = 'poor';
    }

    occupation[mapped] = (occupation[mapped] || 0) + contrib;
  }

  occupation.total = (occupation.poor || 0) + (occupation.burgess || 0) + (occupation.patrician || 0);
  return occupation;
}

/**
 * Calculate available population for an entity by querying current population and its buildings.
 * Returns { entityId, current, occupation, available }
 */
async function calculateAvailablePopulation(entityId) {
  const client = await pool.connect();
  try {
    // get per-type population rows
    const pres = await client.query('SELECT type, current_population, max_population, available_population FROM populations WHERE entity_id = $1', [entityId]);
    const breakdown = { poor: 0, burgess: 0, patrician: 0 };
    const maxBreak = { poor: 0, burgess: 0, patrician: 0 };
    let total = 0;
    let maxTotal = 0;
    for (const r of pres.rows) {
      const t = (r.type || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(breakdown, t)) continue;
      const cur = parseInt(r.current_population || 0, 10);
      const m = parseInt(r.max_population || 0, 10);
      breakdown[t] = cur;
      maxBreak[t] = m;
      total += cur;
      maxTotal += m;
    }

    // get buildings grouped
    const bres = await client.query(`SELECT type, MAX(level) AS level, COUNT(*) AS count FROM buildings WHERE entity_id = $1 GROUP BY type`, [entityId]);
    const buildings = Array.isArray(bres.rows) ? bres.rows : [];
    const occupationPerType = computeOccupationFromBuildings(buildings);

    // available per type = current_population_of_type - occupation_of_type
    const avail = {};
    for (const t of ['poor','burgess','patrician']) {
      avail[t] = Math.max(0, (breakdown[t] || 0) - (occupationPerType[t] || 0));
    }

    const available = (avail.poor || 0) + (avail.burgess || 0) + (avail.patrician || 0);
    return { entityId, current: total, occupation: occupationPerType, available, breakdown, max: maxTotal };
  } finally {
    client.release();
  }
}

/**
 * Client-aware version of calculateAvailablePopulation. Use this when executing inside
 * an existing transaction to avoid creating nested clients/transactions.
 * Returns: { entityId, current, occupation, available, breakdown, total, max }
 */
async function calculateAvailablePopulationWithClient(client, entityId) {
  // reuse getPopulationSummaryWithClient to obtain per-type totals and breakdown
  const pop = await getPopulationSummaryWithClient(client, entityId);
  const current = pop.total || 0;
  const max = pop.max || 0;
  const breakdown = pop.breakdown || {};

  const bres = await client.query(`SELECT type, MAX(level) AS level, COUNT(*) AS count FROM buildings WHERE entity_id = $1 GROUP BY type`, [entityId]);
  const buildings = Array.isArray(bres.rows) ? bres.rows : [];
  const occupation = computeOccupationFromBuildings(buildings);

  const avail = {};
  for (const t of ['poor','burgess','patrician']) {
    avail[t] = Math.max(0, (breakdown[t] || 0) - (occupation[t] || 0));
  }

  const available = (avail.poor || 0) + (avail.burgess || 0) + (avail.patrician || 0);
  return { entityId, current, occupation, available, breakdown, total: current, max };
}

module.exports = { initPopulations, getPopulationSummary, getPopulationSummaryWithClient, setPopulationForTypeWithClient, POP_TYPES, computeOccupationFromBuildings, calculateAvailablePopulation, calculateAvailablePopulationWithClient };


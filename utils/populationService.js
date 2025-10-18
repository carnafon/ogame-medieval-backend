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

// factorial with small cap to avoid huge numbers
function factorial(n) {
  const num = Math.max(0, Math.floor(Number(n) || 0));
  const cap = 10; // avoid extremely large factorials
  const upto = Math.min(num, cap);
  let r = 1;
  for (let i = 2; i <= upto; i++) r *= i;
  return r;
}

/**
 * Compute occupation from an array of building objects.
 * Each building contributes factorial(level) where level is building.level if present,
 * otherwise building.count is used as a fallback. Non-numeric levels/counts are treated as 0.
 * buildings: [{ type, level?, count?, ... }, ...]
 */
function computeOccupationFromBuildings(buildings = []) {
  if (!Array.isArray(buildings)) return 0;
  let occupation = 0;
  for (const b of buildings) {
    if (!b) continue;
    const lvl = Number.isFinite(Number(b.level)) ? Number(b.level) : (Number.isFinite(Number(b.count)) ? Number(b.count) : 0);
    if (lvl <= 0) continue;
    occupation += factorial(lvl);
  }
  return occupation;
}

/**
 * Calculate available population for an entity by querying current population and its buildings.
 * Returns { entityId, current, occupation, available }
 */
async function calculateAvailablePopulation(entityId) {
  const client = await pool.connect();
  try {
    // get population totals
    const pop = await getPopulationSummaryWithClient(client, entityId);
    const current = pop.total || 0;

    // get buildings for entity
    const bres = await client.query('SELECT type, level, count FROM buildings WHERE entity_id = $1', [entityId]);
    const buildings = Array.isArray(bres.rows) ? bres.rows : [];

    const occupation = computeOccupationFromBuildings(buildings);
    // New rule: available population = current_population - occupation (factorial-derived)
    // Clamp at 0 so populations never go negative
    const available = Math.max(0, current - occupation);
    return { entityId, current, occupation, available };
  } finally {
    client.release();
  }
}

module.exports = { initPopulations, getPopulationSummary, getPopulationSummaryWithClient, setPopulationForTypeWithClient, POP_TYPES, computeOccupationFromBuildings, calculateAvailablePopulation };


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

    // Default distribution: all population in 'poor' unless distribution provided
    const defaultTotal = 0; // caller will decide totals; we insert zeros by default
    const dist = distribution || { poor: defaultTotal, burgess: 0, patrician: 0 };

    for (const t of POP_TYPES) {
      const amt = typeof dist[t] === 'number' ? dist[t] : 0;
      await client.query(
        `INSERT INTO populations (entity_id, type, amount) VALUES ($1,$2,$3)
         ON CONFLICT (entity_id, type) DO UPDATE SET amount = EXCLUDED.amount`,
        [entityId, t, amt]
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

module.exports = { initPopulations, getPopulationSummary, getPopulationSummaryWithClient, setPopulationForTypeWithClient, POP_TYPES };


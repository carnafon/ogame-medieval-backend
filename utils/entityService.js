const pool = require('../db');

// Cache whether entities.ai_runtime column exists in the database
let _aiRuntimeExists = null;
async function _hasAiRuntimeColumn(clientOrPool) {
  if (_aiRuntimeExists !== null) return _aiRuntimeExists;
  const client = (clientOrPool && clientOrPool.query && clientOrPool.release) ? clientOrPool : pool;
  try {
    const res = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'ai_runtime' LIMIT 1");
    _aiRuntimeExists = res.rows.length > 0;
  } catch (e) {
    // If the metadata query fails, assume column doesn't exist to remain safe
    _aiRuntimeExists = false;
  }
  return _aiRuntimeExists;
}

/**
 * Create an entity row and initialize its resource_inventory.
 * If a client (pg Client) is provided, uses it and expects caller to manage transactions.
 * data: { user_id, faction_id, type, x_coord, y_coord, population, initialResources }
 */
async function createEntityWithResources(clientOrPool, data) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  if (!usingClient) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createEntityWithResources(client, data);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const client = clientOrPool;
  const resEnt = await client.query(
    `INSERT INTO entities (user_id, type, faction_id, x_coord, y_coord, last_resource_update)
     VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, x_coord, y_coord, last_resource_update, faction_id`,
    [data.user_id || null, data.type || 'player', data.faction_id || null, data.x_coord || 0, data.y_coord || 0]
  );
  const entity = resEnt.rows[0];

  // initialize resource inventory using resourcesService helper
  const resourcesService = require('./resourcesService');
  const rt = await resourcesService.getResourceTypesWithClient(client);
  const initial = data.initialResources || {};
  for (const r of rt) {
    const name = (r.name || '').toLowerCase();
    const amount = typeof initial[name] === 'number' ? initial[name] : 0;
    await client.query('INSERT INTO resource_inventory (entity_id, resource_type_id, amount) VALUES ($1,$2,$3)', [entity.id, r.id, amount]);
  }

  // Initialize populations (three types) for the entity: poor, burgess, patrician
  try {
    const populationService = require('./populationService');
    const popAmount = typeof data.population === 'number' ? data.population : 0;
    const dist = { poor: popAmount, burgess: 0, patrician: 0 };
    await populationService.initPopulations(client, entity.id, dist);
  } catch (popErr) {
    console.warn('Failed to initialize populations for entity:', popErr.message);
  }

  return entity;
}

// Get entity by id. If forUpdate is true and a client is provided, use FOR UPDATE.
async function getEntityById(clientOrPool, id, forUpdate = false) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const client = usingClient ? clientOrPool : pool;

  // Detect once whether ai_runtime column exists and include it only if present.
  const hasAi = await _hasAiRuntimeColumn(client);
  const selectCols = 'e.id, e.user_id, e.faction_id, e.type, e.x_coord, e.y_coord' + (hasAi ? ', e.ai_runtime' : '');
  const q = forUpdate ? `SELECT ${selectCols} FROM entities e WHERE e.id = $1 FOR UPDATE` : `SELECT ${selectCols} FROM entities e WHERE e.id = $1`;

  if (usingClient) {
    const res = await client.query(q, [id]);
    // ensure ai_runtime key exists (fallback to {}) for callers
    if (res.rows.length && hasAi && typeof res.rows[0].ai_runtime === 'undefined') res.rows[0].ai_runtime = {};
    if (res.rows.length && !hasAi) res.rows[0].ai_runtime = {};
    return res.rows.length ? res.rows[0] : null;
  }

  const res = await pool.query(q, [id]);
  if (res.rows.length && hasAi && typeof res.rows[0].ai_runtime === 'undefined') res.rows[0].ai_runtime = {};
  if (res.rows.length && !hasAi) res.rows[0].ai_runtime = {};
  return res.rows.length ? res.rows[0] : null;
}

async function getEntityByUserId(clientOrPool, userId) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `SELECT id, user_id, faction_id, type, x_coord, y_coord FROM entities WHERE user_id = $1 LIMIT 1`;
  if (usingClient) {
    const res = await clientOrPool.query(q, [userId]);
    return res.rows.length ? res.rows[0] : null;
  }
  const res = await pool.query(q, [userId]);
  return res.rows.length ? res.rows[0] : null;
}

async function getEntityCoords(clientOrPool, id) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `SELECT x_coord, y_coord FROM entities WHERE id = $1`;
  if (usingClient) {
    const res = await clientOrPool.query(q, [id]);
    return res.rows.length ? res.rows[0] : { x_coord: 0, y_coord: 0 };
  }
  const res = await pool.query(q, [id]);
  return res.rows.length ? res.rows[0] : { x_coord: 0, y_coord: 0 };
}

async function listNearbyAICities(clientOrPool, excludeId, limit = 8) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `SELECT e.id, e.x_coord, e.y_coord FROM entities e WHERE e.type = 'cityIA' AND e.id <> $1 LIMIT $2`;
  if (usingClient) {
    const res = await clientOrPool.query(q, [excludeId, limit]);
    return res.rows || [];
  }
  const res = await pool.query(q, [excludeId, limit]);
  return res.rows || [];
}

async function findEntityByCoords(clientOrPool, x, y) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `SELECT id FROM entities WHERE x_coord = $1 AND y_coord = $2 LIMIT 1`;
  if (usingClient) {
    const res = await clientOrPool.query(q, [x, y]);
    return res.rows.length ? res.rows[0] : null;
  }
  const res = await pool.query(q, [x, y]);
  return res.rows.length ? res.rows[0] : null;
}

// Return array of all entity ids (client-aware)
async function listAllEntityIds(clientOrPool) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `SELECT id FROM entities`;
  if (usingClient) {
    const res = await clientOrPool.query(q);
    return res.rows.map(r => r.id);
  }
  const res = await pool.query(q);
  return res.rows.map(r => r.id);
}

async function lockEntity(client, id) {
  // expects a client
  await client.query(`SELECT * FROM entities WHERE id = $1 FOR UPDATE`, [id]);
}

async function listEntitiesForMap(clientOrPool) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const q = `
    SELECT 
    e.id,
    CASE WHEN e.type = 'cityIA' AND ac.name IS NOT NULL THEN ac.name ELSE u.username END AS name,
    e.type,
    e.x_coord,
    e.y_coord,
    e.user_id,
    e.faction_id,
    SUM(COALESCE(p.current_population,0)) AS current_population,
    SUM(COALESCE(p.max_population,0)) AS max_population,
    f.name AS faction_name,
    json_agg(json_build_object('type', b.type, 'count', 1)) AS buildings
    FROM entities e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN ai_cities ac ON ac.entity_id = e.id
    LEFT JOIN factions f ON e.faction_id = f.id
    LEFT JOIN populations p ON e.id = p.entity_id
    LEFT JOIN buildings b ON e.id = b.entity_id
    GROUP BY e.id, ac.name, u.username, f.name`;
  if (usingClient) {
    const res = await clientOrPool.query(q);
    const rows = res.rows || [];
    // Enrich each row with resource snapshot via resourcesService
    const resourcesService = require('./resourcesService');
    for (const r of rows) {
      try {
        const inv = await resourcesService.getResourcesWithClient(clientOrPool, r.id);
        r.wood = Number(inv.wood || 0);
        r.stone = Number(inv.stone || 0);
        r.food = Number(inv.food || 0);
      } catch (e) {
        r.wood = 0; r.stone = 0; r.food = 0;
      }
    }
    return rows;
  }
  const res = await pool.query(q);
  const rows = res.rows || [];
  const resourcesService = require('./resourcesService');
  for (const r of rows) {
    try {
      const inv = await resourcesService.getResourcesWithClient(pool, r.id);
      r.wood = Number(inv.wood || 0);
      r.stone = Number(inv.stone || 0);
      r.food = Number(inv.food || 0);
    } catch (e) {
      r.wood = 0; r.stone = 0; r.food = 0;
    }
  }
  return rows;
}

async function updateEntity(clientOrPool, id, changes) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  const fields = [];
  const values = [];
  let idx = 1;
  const allowed = ['x_coord', 'y_coord', 'faction_id', 'type', 'ai_runtime', 'last_resource_update'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, k)) {
      fields.push(`${k} = $${idx++}`);
      values.push(changes[k]);
    }
  }
  if (fields.length === 0) return null;
  values.push(id);
  const q = `UPDATE entities SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
  if (usingClient) {
    const res = await clientOrPool.query(q, values);
    return res.rows.length ? res.rows[0] : null;
  }
  const res = await pool.query(q, values);
  return res.rows.length ? res.rows[0] : null;
}

async function deleteEntity(clientOrPool, id) {
  const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
  if (usingClient) {
    const res = await clientOrPool.query('DELETE FROM entities WHERE id = $1 RETURNING *', [id]);
    return res.rows.length ? res.rows[0] : null;
  }
  const res = await pool.query('DELETE FROM entities WHERE id = $1 RETURNING *', [id]);
  return res.rows.length ? res.rows[0] : null;
}

module.exports = {
  createEntityWithResources,
  getEntityById,
  getEntityByUserId,
  getEntityCoords,
  lockEntity,
  listEntitiesForMap,
  listNearbyAICities,
  listAllEntityIds,
  updateEntity,
  deleteEntity
};

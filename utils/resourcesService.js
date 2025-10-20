const pool = require('../db');

// ----------------------------
// Helpers for resource_types
// ----------------------------
// Return array of { id, name, price_base? } (client-aware)
async function getResourceTypesWithClient(client) {
  const res = await client.query('SELECT id, name, price_base FROM resource_types ORDER BY id');
  return res.rows.map(r => ({ id: r.id, name: (r.name || '').toString(), price_base: r.price_base }));
}

async function getResourceTypes() {
  const res = await pool.query('SELECT id, name, price_base FROM resource_types ORDER BY id');
  return res.rows.map(r => ({ id: r.id, name: (r.name || '').toString(), price_base: r.price_base }));
}

// Return map lower(name) -> id (client-aware)
async function getResourceTypeIdMapWithClient(client) {
  const rows = await client.query('SELECT id, lower(name) as name FROM resource_types');
  return Object.fromEntries(rows.rows.map(r => [r.name, r.id]));
}

async function getResourceTypeIdMap() {
  const rows = await pool.query('SELECT id, lower(name) as name FROM resource_types');
  return Object.fromEntries(rows.rows.map(r => [r.name, r.id]));
}

// Return single resource type (id,name,price_base) by lower(name)
async function getResourceTypeByNameWithClient(client, lowerName) {
  const res = await client.query('SELECT id, name, price_base FROM resource_types WHERE lower(name) = $1 LIMIT 1', [lowerName]);
  return res.rows.length ? res.rows[0] : null;
}

async function getResourceTypeByName(lowerName) {
  const res = await pool.query('SELECT id, name, price_base FROM resource_types WHERE lower(name) = $1 LIMIT 1', [lowerName]);
  return res.rows.length ? res.rows[0] : null;
}

// Return map lower(name) -> price_base
async function getPriceBaseMapWithClient(client) {
  const res = await client.query('SELECT lower(name) as name, price_base FROM resource_types');
  const m = {};
  for (const r of res.rows) m[r.name] = Number(r.price_base) || 1;
  return m;
}

async function getPriceBaseMap() {
  const res = await pool.query('SELECT lower(name) as name, price_base FROM resource_types');
  const m = {};
  for (const r of res.rows) m[r.name] = Number(r.price_base) || 1;
  return m;
}

// Return total stock across all entities for a given resource lower(name)
async function getTotalStockForResourceWithClient(client, lowerName) {
  const res = await client.query(
    `SELECT COALESCE(SUM(ri.amount),0)::bigint as stock
     FROM resource_inventory ri
     JOIN resource_types rt ON ri.resource_type_id = rt.id
     WHERE lower(rt.name) = $1`,
    [lowerName]
  );
  return Number((res.rows[0] && res.rows[0].stock) || 0);
}

async function getTotalStockForResource(lowerName) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(ri.amount),0)::bigint as stock
     FROM resource_inventory ri
     JOIN resource_types rt ON ri.resource_type_id = rt.id
     WHERE lower(rt.name) = $1`,
    [lowerName]
  );
  return Number((res.rows[0] && res.rows[0].stock) || 0);
}

// Return resource type name by id
async function getResourceTypeNameByIdWithClient(client, id) {
  const res = await client.query('SELECT name FROM resource_types WHERE id = $1 LIMIT 1', [id]);
  return res.rows.length ? res.rows[0].name : null;
}

async function getResourceTypeNameById(id) {
  const res = await pool.query('SELECT name FROM resource_types WHERE id = $1 LIMIT 1', [id]);
  return res.rows.length ? res.rows[0].name : null;
}

async function getResources(entityId) {
  const q = `SELECT rt.name, ri.amount
             FROM resource_inventory ri
             JOIN resource_types rt ON ri.resource_type_id = rt.id
             WHERE ri.entity_id = $1`;
  const res = await pool.query(q, [entityId]);
  return Object.fromEntries(res.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
}

// Set absolute amounts for provided resources { wood, stone, food }
async function setResources(entityId, resources) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (typeof resources.wood === 'number') {
      await client.query(
        `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
        [resources.wood, entityId]
      );
    }
    if (typeof resources.stone === 'number') {
      await client.query(
        `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
        [resources.stone, entityId]
      );
    }
    if (typeof resources.food === 'number') {
      await client.query(
        `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
        [resources.food, entityId]
      );
    }
    const updated = await client.query(
      `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
      [entityId]
    );
    await client.query('COMMIT');
    return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// setResources using existing client (assumes caller manages transaction)
async function setResourcesWithClient(client, entityId, resources) {
  if (typeof resources.wood === 'number') {
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
      [resources.wood, entityId]
    );
  }
  if (typeof resources.stone === 'number') {
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
      [resources.stone, entityId]
    );
  }
  if (typeof resources.food === 'number') {
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
      [resources.food, entityId]
    );
  }
  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
}

// Generic setter that accepts an object with arbitrary resource keys and updates them within the provided client transaction.
// resources: { wood: 123, copper: 5, food: 10, ... }
async function setResourcesWithClientGeneric(client, entityId, resources) {
  // Load mapping resource name -> id once
  const resTypes = await client.query(`SELECT id, name FROM resource_types`);
  const nameToId = Object.fromEntries(resTypes.rows.map(r => [r.name.toLowerCase(), r.id]));

  for (const [key, value] of Object.entries(resources)) {
    if (!Object.prototype.hasOwnProperty.call(nameToId, key)) continue; // ignore unknown resource keys
    // Upsert pattern: update existing row
    // Use INSERT ... ON CONFLICT to ensure the inventory row exists and set the absolute amount
    await client.query(
      `INSERT INTO resource_inventory (entity_id, resource_type_id, amount)
       VALUES ($1, $2, GREATEST(0, $3))
       ON CONFLICT (entity_id, resource_type_id) DO UPDATE SET amount = GREATEST(0, $3)`,
      [entityId, nameToId[key], value]
    );
  }

  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
}

// Return all resource type names as an array, client-aware
async function getResourceTypeNames(client = null) {
  if (client && client.query) {
    const res = await client.query('SELECT name FROM resource_types ORDER BY id');
    return res.rows.map(r => (r.name || '').toLowerCase());
  }
  const res = await pool.query('SELECT name FROM resource_types ORDER BY id');
  return res.rows.map(r => (r.name || '').toLowerCase());
}

// Client-aware getter for resource amounts for an entity (returns map name->amount)
async function getResourcesWithClient(client, entityId) {
  const res = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(res.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10) || 0]));
}

// Client-aware lock helper (SELECT FOR UPDATE) to centralize locking
async function lockResourceRowsWithClient(client, entityId) {
  await client.query(`SELECT ri.id FROM resource_inventory ri WHERE ri.entity_id = $1 FOR UPDATE`, [entityId]);
}

// Consume (subtract) costs atomically. costs: { wood, stone, food }
// Returns updated resources or throws Error('Recursos insuficientes')
async function consumeResources(entityId, costs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // lock rows
    const rows = await client.query(
      `SELECT rt.name, ri.amount
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE ri.entity_id = $1
       FOR UPDATE`,
      [entityId]
    );

    const current = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));

    // check sufficiency
    for (const key of ['wood', 'stone', 'food']) {
      const need = costs[key] || 0;
      if ((current[key] || 0) < need) {
        await client.query('ROLLBACK');
        const err = new Error(`Recursos insuficientes: ${key} (necesita ${need}, tiene ${current[key] || 0})`);
        err.code = 'INSUFFICIENT';
        err.resource = key;
        err.need = need;
        err.have = current[key] || 0;
        throw err;
      }
    }

    // subtract
    if (typeof costs.wood === 'number' && costs.wood !== 0) {
      await client.query(
        `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
        [costs.wood, entityId]
      );
    }
    if (typeof costs.stone === 'number' && costs.stone !== 0) {
      await client.query(
        `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
        [costs.stone, entityId]
      );
    }
    if (typeof costs.food === 'number' && costs.food !== 0) {
      await client.query(
        `UPDATE resource_inventory SET amount = GREATEST(0, amount - $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
        [costs.food, entityId]
      );
    }

    const updated = await client.query(
      `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
      [entityId]
    );
    await client.query('COMMIT');
    return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Consume using an existing client (assumes caller has begun transaction and locked rows as needed)
async function consumeResourcesWithClient(client, entityId, costs) {
  // lock rows
  const rows = await client.query(
    `SELECT rt.name, ri.amount
     FROM resource_inventory ri
     JOIN resource_types rt ON ri.resource_type_id = rt.id
     WHERE ri.entity_id = $1
     FOR UPDATE`,
    [entityId]
  );

  const current = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));

  for (const key of ['wood', 'stone', 'food']) {
    const need = costs[key] || 0;
    if ((current[key] || 0) < need) {
      const err = new Error(`Recursos insuficientes: ${key} (necesita ${need}, tiene ${current[key] || 0})`);
      err.code = 'INSUFFICIENT';
      err.resource = key;
      err.need = need;
      err.have = current[key] || 0;
      throw err;
    }
  }

  if (typeof costs.wood === 'number' && costs.wood !== 0) {
    await client.query(
      `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
      [costs.wood, entityId]
    );
  }
  if (typeof costs.stone === 'number' && costs.stone !== 0) {
    await client.query(
      `UPDATE resource_inventory SET amount = amount - $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
      [costs.stone, entityId]
    );
  }
  if (typeof costs.food === 'number' && costs.food !== 0) {
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, amount - $1) WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
      [costs.food, entityId]
    );
  }

  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
}

// Generic consume that supports arbitrary resource keys (e.g., lumber, baked_brick)
async function consumeResourcesWithClientGeneric(client, entityId, costs) {
  // lock rows
  const rows = await client.query(
    `SELECT rt.name, ri.amount
     FROM resource_inventory ri
     JOIN resource_types rt ON ri.resource_type_id = rt.id
     WHERE ri.entity_id = $1
     FOR UPDATE`,
    [entityId]
  );

  const current = Object.fromEntries(rows.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));

  // Check sufficiency for all provided keys
  for (const [k, need] of Object.entries(costs || {})) {
    const key = (k || '').toString().toLowerCase();
    const req = Number(need) || 0;
    if ((current[key] || 0) < req) {
      const err = new Error(`Recursos insuficientes: ${key} (necesita ${req}, tiene ${current[key] || 0})`);
      err.code = 'INSUFFICIENT';
      err.resource = key;
      err.need = req;
      err.have = current[key] || 0;
      throw err;
    }
  }

  // Perform updates
  // Build a mapping name->id
  const resTypes = await client.query(`SELECT id, lower(name) as name FROM resource_types`);
  const nameToId = Object.fromEntries(resTypes.rows.map(r => [r.name, r.id]));

  for (const [k, need] of Object.entries(costs || {})) {
    const key = (k || '').toString().toLowerCase();
    const req = Number(need) || 0;
    if (req <= 0) continue;
    if (!Object.prototype.hasOwnProperty.call(nameToId, key)) {
      // unknown resource -> skip
      continue;
    }
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, amount - $1) WHERE entity_id = $2 AND resource_type_id = $3`,
      [req, entityId, nameToId[key]]
    );
  }

  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
}

// Adjust resources by deltas (positive to add, negative to subtract). Deltas keys are resource names lowercased.
// Applies GREATEST(0, amount + delta) to avoid negative amounts. Returns updated snapshot map.
async function adjustResourcesWithClientGeneric(client, entityId, deltas) {
  if (!deltas || Object.keys(deltas).length === 0) {
    const updated = await client.query(
      `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
      [entityId]
    );
    return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10) || 0]));
  }

  const resTypes = await client.query(`SELECT id, lower(name) as name FROM resource_types`);
  const nameToId = Object.fromEntries(resTypes.rows.map(r => [r.name, r.id]));

  for (const [k, v] of Object.entries(deltas)) {
    const key = (k || '').toString().toLowerCase();
    const delta = Number(v) || 0;
    if (!Object.prototype.hasOwnProperty.call(nameToId, key)) continue; // skip unknown
    if (delta === 0) continue;
    // Note: use GREATEST to prevent negative final amounts
    await client.query(
      `UPDATE resource_inventory SET amount = GREATEST(0, amount + $1) WHERE entity_id = $2 AND resource_type_id = $3`,
      [delta, entityId, nameToId[key]]
    );
  }

  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10) || 0]));
}

module.exports = {
  getResources,
  setResources,
  consumeResources,
  consumeResourcesWithClient,
  setResourcesWithClient
};
// Export the generic setter as well
module.exports.setResourcesWithClientGeneric = setResourcesWithClientGeneric;
// Export resource type helper
module.exports.getResourceTypeNames = getResourceTypeNames;
// Export generic consumer
module.exports.consumeResourcesWithClientGeneric = consumeResourcesWithClientGeneric;
// export client-aware helpers
module.exports.getResourcesWithClient = getResourcesWithClient;
module.exports.lockResourceRowsWithClient = lockResourceRowsWithClient;
// export adjust helper
module.exports.adjustResourcesWithClientGeneric = adjustResourcesWithClientGeneric;
// resource_types helpers
module.exports.getResourceTypes = getResourceTypes;
module.exports.getResourceTypesWithClient = getResourceTypesWithClient;
module.exports.getResourceTypeIdMap = getResourceTypeIdMap;
module.exports.getResourceTypeIdMapWithClient = getResourceTypeIdMapWithClient;
module.exports.getResourceTypeByName = getResourceTypeByName;
module.exports.getResourceTypeByNameWithClient = getResourceTypeByNameWithClient;
module.exports.getPriceBaseMap = getPriceBaseMap;
module.exports.getPriceBaseMapWithClient = getPriceBaseMapWithClient;
module.exports.getResourceTypeNameById = getResourceTypeNameById;
module.exports.getResourceTypeNameByIdWithClient = getResourceTypeNameByIdWithClient;
module.exports.getTotalStockForResourceWithClient = getTotalStockForResourceWithClient;
module.exports.getTotalStockForResource = getTotalStockForResource;

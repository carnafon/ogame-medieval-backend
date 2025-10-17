const pool = require('../db');

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
        `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
        [resources.wood, entityId]
      );
    }
    if (typeof resources.stone === 'number') {
      await client.query(
        `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
        [resources.stone, entityId]
      );
    }
    if (typeof resources.food === 'number') {
      await client.query(
        `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
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
      `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='wood')`,
      [resources.wood, entityId]
    );
  }
  if (typeof resources.stone === 'number') {
    await client.query(
      `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='stone')`,
      [resources.stone, entityId]
    );
  }
  if (typeof resources.food === 'number') {
    await client.query(
      `UPDATE resource_inventory SET amount = $1 WHERE entity_id = $2 AND resource_type_id = (SELECT id FROM resource_types WHERE name='food')`,
      [resources.food, entityId]
    );
  }
  const updated = await client.query(
    `SELECT rt.name, ri.amount FROM resource_inventory ri JOIN resource_types rt ON ri.resource_type_id = rt.id WHERE ri.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(updated.rows.map(r => [r.name.toLowerCase(), parseInt(r.amount, 10)]));
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
        const err = new Error('Recursos insuficientes para construir.');
        err.code = 'INSUFFICIENT';
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
      const err = new Error('Recursos insuficientes para construir.');
      err.code = 'INSUFFICIENT';
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

module.exports = {
  getResources,
  setResources,
  consumeResources,
  consumeResourcesWithClient,
  setResourcesWithClient
};

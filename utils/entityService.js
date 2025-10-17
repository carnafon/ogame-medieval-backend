const pool = require('../db');

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
    `INSERT INTO entities (user_id, type, faction_id, x_coord, y_coord, current_population, last_resource_update)
     VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING id, x_coord, y_coord, current_population, last_resource_update, faction_id`,
    [data.user_id || null, data.type || 'player', data.faction_id || null, data.x_coord || 0, data.y_coord || 0, data.population || 0]
  );
  const entity = resEnt.rows[0];

  // initialize resource inventory
  const rt = await client.query('SELECT id, name FROM resource_types');
  const initial = data.initialResources || {};
  for (const r of rt.rows) {
    const name = (r.name || '').toLowerCase();
    const amount = typeof initial[name] === 'number' ? initial[name] : 0;
    await client.query('INSERT INTO resource_inventory (entity_id, resource_type_id, amount) VALUES ($1,$2,$3)', [entity.id, r.id, amount]);
  }

  return entity;
}

module.exports = { createEntityWithResources };

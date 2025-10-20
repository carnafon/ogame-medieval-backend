const pool = require('../db');

async function getBuildings(entityId) {
  const res = await pool.query(
    `SELECT type, MAX(level) AS level, COUNT(*) as count
     FROM buildings
     WHERE entity_id = $1
     GROUP BY type`,
    [entityId]
  );
  return res.rows.map(r => ({ type: r.type, level: r.level ? parseInt(r.level, 10) : 0, count: parseInt(r.count, 10) }));
}

async function getBuildingLevel(entityId, type) {
  const res = await pool.query(
    `SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1`,
    [entityId, type]
  );
  return res.rows.length > 0 ? parseInt(res.rows[0].level, 10) : 0;
}

// Client-aware: get building level using provided client
async function getBuildingLevelWithClient(client, entityId, type) {
  const res = await client.query(`SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1`, [entityId, type]);
  return res.rows.length > 0 ? parseInt(res.rows[0].level, 10) : 0;
}

// Client-aware: increment building level (atomic when executed within a transaction/client)
async function incrementBuildingLevelWithClient(client, entityId, type) {
  const res = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1 FOR UPDATE', [entityId, type]);
  if (res.rows.length > 0) {
    await client.query('UPDATE buildings SET level = level + 1 WHERE entity_id = $1 AND type = $2', [entityId, type]);
    return true;
  }
  // create initial level
  await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,1)', [entityId, type]);
  return true;
}

// Client-aware: set building level to a specific value
async function setBuildingLevelWithClient(client, entityId, type, level) {
  const res = await client.query('SELECT level FROM buildings WHERE entity_id = $1 AND type = $2 LIMIT 1 FOR UPDATE', [entityId, type]);
  if (res.rows.length > 0) {
    await client.query('UPDATE buildings SET level = $1 WHERE entity_id = $2 AND type = $3', [level, entityId, type]);
    return true;
  }
  await client.query('INSERT INTO buildings (entity_id, type, level) VALUES ($1,$2,$3)', [entityId, type, level]);
  return true;
}

module.exports = {
  getBuildings,
  getBuildingLevel,
  getBuildingLevelWithClient,
  incrementBuildingLevelWithClient,
  setBuildingLevelWithClient,
};

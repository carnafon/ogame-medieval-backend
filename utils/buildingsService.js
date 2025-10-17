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

module.exports = {
  getBuildings,
  getBuildingLevel,
};

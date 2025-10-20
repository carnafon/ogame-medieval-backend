const pool = require('../db');

async function main() {
  console.log('Starting backfill of resource_inventory for all entities...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Insert missing rows (entity x resource_type) with amount = 0
    const q = `
      INSERT INTO resource_inventory (entity_id, resource_type_id, amount)
      SELECT e.id, rt.id, 0
      FROM entities e
      CROSS JOIN resource_types rt
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_inventory ri WHERE ri.entity_id = e.id AND ri.resource_type_id = rt.id
      )
    `;
    const res = await client.query(q);
    await client.query('COMMIT');
    console.log('Backfill complete. Inserted rows:', res.rowCount);
    return res.rowCount;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Backfill failed:', err.message || err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { main };

// If run directly from node, execute main
if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(1));
}

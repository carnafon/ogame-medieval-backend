const pool = require('../db');

async function ensure() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const desired = [
      { name: 'wood', price_base: 1 },
      { name: 'lumber', price_base: 2 }
    ];
    for (const r of desired) {
      const res = await client.query('SELECT id FROM resource_types WHERE lower(name) = $1 LIMIT 1', [r.name]);
      if (res.rows.length === 0) {
        await client.query('INSERT INTO resource_types (name, price_base) VALUES ($1, $2)', [r.name, r.price_base]);
        console.log('Inserted resource_type:', r.name);
      } else {
        console.log('resource_type exists:', r.name);
      }
    }
    await client.query('COMMIT');
    console.log('ensure_resource_types: done');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (er) {}
    console.error('ensure_resource_types failed:', e && e.message);
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  ensure().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { ensure };

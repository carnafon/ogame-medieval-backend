/**
 * ai_city_service.js
 * Helper utilities to manage AI cities (ai_cities table).
 * Provides CRUD-like functions and helpers to lock and update rows inside transactions.
 */

const pool = require('../db');

async function listCities(clientOrPool, forUpdate = false) {
    const q = forUpdate ? 'SELECT * FROM ai_cities FOR UPDATE' : 'SELECT * FROM ai_cities';
    const res = clientOrPool.query ? await clientOrPool.query(q) : await pool.query(q);
    return res.rows.map(r => ({ id: r.id, name: r.name, created_at: r.created_at }));
}

async function getCityById(clientOrPool, id, forUpdate = false) {
    const q = forUpdate ? 'SELECT * FROM ai_cities WHERE id = $1 FOR UPDATE' : 'SELECT * FROM ai_cities WHERE id = $1';
    const res = clientOrPool.query ? await clientOrPool.query(q, [id]) : await pool.query(q, [id]);
    return res.rows.length ? res.rows[0] : null;
}

async function createCity(clientOrPool, cityData) {
    const q = `INSERT INTO ai_cities (name) VALUES ($1) RETURNING *`;
    const params = [cityData.name || 'IA City'];
    const res = clientOrPool.query ? await clientOrPool.query(q, params) : await pool.query(q, params);
    return res.rows[0];
}

/**
 * Create a paired entities row and ai_cities row so the AI city exists as a game entity.
 * Returns { entity, ai_city }
 */
async function createPairedCity(clientOrPool, cityData) {
    // We'll open/require a client if a pool was provided
    const usingClient = !!(clientOrPool && clientOrPool.query && clientOrPool.release);
    if (!usingClient) {
        // Use a new client transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await createPairedCity(client, cityData);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Using existing client
    const client = clientOrPool;
    // 1. create entity row
    const entQ = `INSERT INTO entities (user_id, faction_id, type, x_coord, y_coord, population) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
    const entParams = [null, cityData.faction_id || null, cityData.type || 'cityIA', cityData.x_coord || 0, cityData.y_coord || 0, cityData.population || 0];
    const entRes = await client.query(entQ, entParams);
    const entity = entRes.rows[0];

    // 2. create ai_cities row and attach to entity
    const ai = await createCity(client, { name: cityData.name || `IA City ${entity.id}` });
    await client.query('UPDATE ai_cities SET entity_id = $1 WHERE id = $2', [entity.id, ai.id]);

    // 3. store runtime inside entities.ai_runtime
    const runtime = cityData.runtime || { buildings: {}, resources: {}, population: cityData.population || 0, pop_consumed: 0, current_construction: null };
    await client.query('UPDATE entities SET ai_runtime = $1 WHERE id = $2', [runtime, entity.id]);

    return { entity, ai_city: ai };
}

async function deleteCityById(clientOrPool, id) {
    // Delete ai_cities row. Also delete any map_entities links and optionally entities if requested via options.
    const city = await getCityById(clientOrPool, id, false);
    if (!city) return null;
    const client = clientOrPool.query ? clientOrPool : pool;
    // Find linked entity via ai_cities.entity_id
    const aiRow = await client.query('SELECT entity_id FROM ai_cities WHERE id = $1', [id]);
    if (aiRow.rows.length > 0 && aiRow.rows[0].entity_id) {
        await client.query('DELETE FROM entities WHERE id = $1', [aiRow.rows[0].entity_id]);
    }
    await client.query('DELETE FROM ai_cities WHERE id = $1', [id]);
    return city;
}

async function updateCityById(clientOrPool, id, changes) {
    // Build SET list dynamically for allowed fields
    const fields = [];
    const values = [];
    let idx = 1;
    const allowed = ['name'];
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) {
            fields.push(`${k} = $${idx}`);
            values.push(changes[k]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    const q = `UPDATE ai_cities SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    values.push(id);
    const res = clientOrPool.query ? await clientOrPool.query(q, values) : await pool.query(q, values);
    return res.rows.length ? res.rows[0] : null;
}

module.exports = {
    listCities,
    getCityById,
    createCity,
    createPairedCity,
    deleteCityById,
    updateCityById
};

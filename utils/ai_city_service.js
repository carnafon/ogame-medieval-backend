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

    // Compute initialResources: prefer explicit initialResources, otherwise default 1000 for every resource type
    let initialResources = cityData.initialResources;
    if (!initialResources || Object.keys(initialResources).length === 0) {
        const rtRes = await client.query('SELECT name FROM resource_types');
        initialResources = {};
        rtRes.rows.forEach(r => { initialResources[(r.name || '').toLowerCase()] = 1000; });
    }

    // 1. create entity row using shared service
    const entityService = require('./entityService');
    const entity = await entityService.createEntityWithResources(client, {
        user_id: cityData.user_id || null,
        faction_id: cityData.faction_id || null,
        type: cityData.type || 'cityIA',
        x_coord: cityData.x_coord || 0,
        y_coord: cityData.y_coord || 0,
        population: cityData.population || 100,
        initialResources
    });

    // 2. create ai_cities row and attach to entity
    const ai = await createCity(client, { name: cityData.name || `IA City ${entity.id}` });
    await client.query('UPDATE ai_cities SET entity_id = $1 WHERE id = $2', [entity.id, ai.id]);

    // 2b. Ensure resource_inventory is set to the desired initialResources (defensive)
    try {
        const resourcesService = require('./resourcesService');
        await resourcesService.setResourcesWithClientGeneric(client, entity.id, initialResources);
    } catch (rsErr) {
        // non-fatal: log and continue
        console.warn('Failed to initialize AI city resources in resource_inventory:', rsErr.message);
    }

    // Additional defensive upsert: ensure a resource_inventory row exists for every resource type.
    // This protects against cases where the shared entity creator didn't insert rows (e.g. schema mismatch).
    try {
        const rt = await client.query('SELECT id, name FROM resource_types');
        for (const r of rt.rows) {
            const name = (r.name || '').toLowerCase();
            const amount = typeof initialResources[name] === 'number' ? initialResources[name] : 0;
            // Use upsert to create or set the amount
            await client.query(
                `INSERT INTO resource_inventory (entity_id, resource_type_id, amount)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (entity_id, resource_type_id) DO UPDATE SET amount = EXCLUDED.amount`,
                [entity.id, r.id, amount]
            );
        }
    } catch (upErr) {
        console.warn('Failed to upsert resource_inventory defensive rows for AI city:', upErr.message);
    }

    // Do NOT store runtime in entities.ai_runtime for AI cities.
    // Resource amounts are already initialized in resource_inventory by createEntityWithResources.
    // Buildings are persisted in the `buildings` table when the AI builds.

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

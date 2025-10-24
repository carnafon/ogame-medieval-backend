/**
 * ai_city_service.js
 * Utilidades auxiliares para gestionar ciudades IA (tabla ai_cities).
 * Provee funciones tipo CRUD y ayudantes para bloquear y actualizar filas dentro de transacciones.
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
    // Abrimos/obtenemos un cliente si se proporcionó un pool
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

    // Compute initialResources: prefer explicit initialResources, otherwise use balanced AI defaults
    let initialResources = cityData.initialResources;
    if (!initialResources || Object.keys(initialResources).length === 0) {
        // Balanced defaults for AI cities (small starting push)
        const aiDefaults = {
            wood: 800,
            stone: 700,
            food: 1200,
            water: 200,
            coal: 100,
            clay: 100,
            honey: 400,
            wool: 400,
            copper: 800,
            leather: 400,
            gold: 3000
        };
        const resourcesService = require('./resourcesService');
        const rtRes = await resourcesService.getResourceTypesWithClient(client);
        initialResources = {};
        // Only assign values for known resource types; others default to 0
        rtRes.forEach(r => {
            const name = (r.name || '').toLowerCase();
            initialResources[name] = typeof aiDefaults[name] === 'number' ? aiDefaults[name] : 0;
        });
    }

    // 1. crear la fila de entidad usando el servicio compartido
    const entityService = require('./entityService');
        const entity = await entityService.createEntityWithResources(client, {
        user_id: cityData.user_id || null,
        faction_id: cityData.faction_id || null,
        type: cityData.type || 'cityIA',
        x_coord: cityData.x_coord || 0,
        y_coord: cityData.y_coord || 0,
        population: cityData.population || 1,
        initialResources
    });

    // 2. crear la fila en ai_cities y vincularla a la entidad
    const ai = await createCity(client, { name: cityData.name || `IA City ${entity.id}` });
    await client.query('UPDATE ai_cities SET entity_id = $1 WHERE id = $2', [entity.id, ai.id]);

    // 2b. Asegurarse de que resource_inventory está configurado con los initialResources deseados (defensivo)
    try {
        const resourcesService = require('./resourcesService');
        await resourcesService.setResourcesWithClientGeneric(client, entity.id, initialResources);
    } catch (rsErr) {
        // non-fatal: log and continue
        console.warn('Failed to initialize AI city resources in resource_inventory:', rsErr.message);
    }

    // Upsert defensivo adicional: garantizar que existe una fila en resource_inventory para cada tipo de recurso.
    // Protege contra casos donde el creador de entidades compartido no insertó filas (por ejemplo, desajuste de esquema).
    try {
        const resourcesService = require('./resourcesService');
        const rt = await resourcesService.getResourceTypesWithClient(client);
        for (const r of rt) {
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

    // NO almacenar runtime en entities.ai_runtime para ciudades IA.
    // Las cantidades de recursos ya se inicializan en resource_inventory por createEntityWithResources.
    // Los edificios se persisten en la tabla `buildings` cuando la IA construye.

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
        const entityService = require('./entityService');
        try {
            await entityService.deleteEntity(client, aiRow.rows[0].entity_id);
        } catch (e) {
            // fallback: attempt deletion via entityService using pool (centralized, no raw SQL)
            try {
                await entityService.deleteEntity(pool, aiRow.rows[0].entity_id);
            } catch (e2) {
                // If even that fails, log and continue (avoid raw SQL here to keep centralization)
                console.warn('Failed to delete linked entity via entityService fallback:', e2.message);
            }
        }
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

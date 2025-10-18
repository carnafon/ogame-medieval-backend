const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration, TICK_SECONDS, RESOURCE_GENERATOR_WOOD_PER_TICK, RESOURCE_GENERATOR_STONE_PER_TICK } = require('../utils/gameUtils');
const { getBuildings } = require('../utils/buildingsService');

// Parámetros configurables
const POPULATION_CHANGE_RATE = 0; // cambio de población por tick

// Opciones por defecto que la tarea usará
const currentOptions = {
    woodPerTick: RESOURCE_GENERATOR_WOOD_PER_TICK,
    stonePerTick: RESOURCE_GENERATOR_STONE_PER_TICK
};

/**
 * Procesa la generación de recursos y población para una sola entidad.
 * @param {Number} entityId
 * @param {Object} options
 */

// Función helper para procesar la lógica de recursos de un solo usuario
async function processEntity(entityId, options) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');


            // 🔹 Obtener datos base de la entidad (lock solo la fila de entities para evitar FOR UPDATE en outer join)
            const entityRes = await client.query(
              `SELECT id, type, last_resource_update, faction_id, x_coord, y_coord
                 FROM entities
                 WHERE id = $1
                 FOR UPDATE`,
                [entityId]
            );

    if (entityRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const entity = entityRes.rows[0];
    // Obtener nombre de facción (no necesita lock)
    let faction_name = '';
    if (entity.faction_id) {
        try {
            const fRes = await client.query('SELECT name FROM factions WHERE id = $1', [entity.faction_id]);
            faction_name = fRes.rows.length ? fRes.rows[0].name : '';
        } catch (e) {
            faction_name = '';
        }
    }
    const last = entity.last_resource_update ? new Date(entity.last_resource_update) : new Date();
    const now = new Date();
    const secondsElapsed = Math.max(0, Math.floor((now - last) / 1000));
    if (secondsElapsed <= 0) {
      await client.query('COMMIT');
      return;
    }




    // Obtener edificios del usuario
    const buildings = await getBuildings(entityId);
    // usar populationService centralizado
    const populationService = require('../utils/populationService');
    // Obtener resumen poblacional y available dentro de la misma transaccion
    const popCalc = await populationService.calculateAvailablePopulationWithClient(client, entityId);
    const popSummary = { total: popCalc.total, max: popCalc.max, breakdown: popCalc.breakdown, available: popCalc.available };
    const occupation = popCalc.occupation;
    const popStats = calculatePopulationStats(buildings, parseInt(popSummary.total, 10));
    const accrued = calculateProductionForDuration(buildings, popStats, secondsElapsed);
    const maxPopulation = popStats.max_population || entity.max_population || 0;

        // Aplicar sumas fijas por tick configurables
        const woodPerTick = options && options.woodPerTick ? parseFloat(options.woodPerTick) : 0;
        const stonePerTick = options && options.stonePerTick ? parseFloat(options.stonePerTick) : 0;

        const ticks = Math.floor(secondsElapsed / TICK_SECONDS);
        const extraWood = ticks * Math.floor(woodPerTick);
        const extraStone= ticks * Math.floor(stonePerTick);

            // 🔹 Cargar inventario de recursos usando el servicio
            const currentResources = await require('../utils/resourcesService').getResources(entityId);

            // 🔹 Actualizar cantidades para todas las claves producidas
            let produced = accrued || {};
            const newResources = { ...currentResources };

            // --- Consumo de recursos por población (se ejecuta antes de la producción) ---
            const resourcesService = require('../utils/resourcesService');
            const { RESOURCE_CATEGORIES } = require('../utils/gameUtils');
            // fetch all resource types and partition by category
            const allTypes = await resourcesService.getResourceTypeNames(client);
            const COMMON_RES = [];
            const PROCESSED_RES = [];
            const SPECIAL_RES = [];
            allTypes.forEach(name => {
                const cat = (RESOURCE_CATEGORIES[name] || 'common').toLowerCase();
                if (cat === 'common') COMMON_RES.push(name);
                else if (cat === 'processed') PROCESSED_RES.push(name);
                else if (cat === 'specialized' || cat === 'special') SPECIAL_RES.push(name);
            });

            // Load per-type population rows so we have current and max per type
            const popRows = await client.query('SELECT type, current_population, max_population FROM populations WHERE entity_id = $1', [entityId]);
            const popMap = {};
            popRows.rows.forEach(r => {
                popMap[(r.type || '').toLowerCase()] = {
                    current: Number(r.current_population) || 0,
                    max: Number(r.max_population) || 0
                };
            });

            const tryConsumeForType = (typeKey, resourceKeys) => {
                const cur = popMap[typeKey]?.current || 0;
                const max = popMap[typeKey]?.max || 0;
                if (cur <= 0) return { newCurrent: cur, max };

                const required = cur; // each citizen consumes 1 unit of each listed resource
                const allHave = resourceKeys.every(k => (newResources[k] || 0) >= required);
                if (!allHave) {
                    // Not enough: decrement population by 1
                    const newCur = Math.max(0, cur - 1);
                    return { newCurrent: newCur, max };
                }

                // Consume resources
                resourceKeys.forEach(k => {
                    newResources[k] = Math.max(0, (newResources[k] || 0) - required);
                });

                // If there is spare capacity (max - cur > 0) then population increases by 1
                let newCur = cur;
                if ((max - cur) > 0) newCur = Math.min(max, cur + 1);
                return { newCurrent: newCur, max };
            };

            const poorRes = tryConsumeForType('poor', COMMON_RES);
            const burgessRes = tryConsumeForType('burgess', PROCESSED_RES);
            const patricianRes = tryConsumeForType('patrician', SPECIAL_RES);

            // Persist updated population rows for each type
            try {
                if (poorRes.newCurrent !== undefined) {
                    // available = current - occupation (clamped at 0)
                    const avail = Math.max(0, poorRes.newCurrent - occupation);
                    await populationService.setPopulationForTypeWithClient(client, entityId, 'poor', poorRes.newCurrent, poorRes.max || 0, avail);
                    // update local popMap as well
                    popMap.poor = { current: poorRes.newCurrent, max: poorRes.max || 0 };
                }
                if (burgessRes.newCurrent !== undefined) {
                    const avail = Math.max(0, burgessRes.newCurrent - occupation);
                    await populationService.setPopulationForTypeWithClient(client, entityId, 'burgess', burgessRes.newCurrent, burgessRes.max || 0, avail);
                    popMap.burgess = { current: burgessRes.newCurrent, max: burgessRes.max || 0 };
                }
                if (patricianRes.newCurrent !== undefined) {
                    const avail = Math.max(0, patricianRes.newCurrent - occupation);
                    await populationService.setPopulationForTypeWithClient(client, entityId, 'patrician', patricianRes.newCurrent, patricianRes.max || 0, avail);
                    popMap.patrician = { current: patricianRes.newCurrent, max: patricianRes.max || 0 };
                }
            } catch (pErr) {
                console.warn('Failed to persist population type updates:', pErr.message);
            }

            // Procesamiento con recetas: si un recurso producido es de tipo processed
            // y tiene una receta, comprobamos si hay insumos suficientes. Solo
            // producimos la cantidad de unidades que puedan cubrirse con insumos.
            const { PROCESSING_RECIPES } = require('../utils/gameUtils');

            Object.keys(produced).forEach(k => {
                const add = produced[k] || 0;
                // Si no hay receta, sumar tal cual
                const recipe = PROCESSING_RECIPES[k];
                if (!recipe || add <= 0) {
                    newResources[k] = (newResources[k] || 0) + add;
                    return;
                }

                // Para recursos procesados con receta, calcular cuántas unidades
                // podemos producir dado el inventario actual. La receta define
                // insumos por unidad.
                let producibleUnits = add;
                Object.keys(recipe).forEach(inputKey => {
                    const requiredPerUnit = recipe[inputKey] || 0;
                    if (requiredPerUnit <= 0) return;
                    const have = newResources[inputKey] || 0;
                    const maxByThisInput = Math.floor(have / requiredPerUnit);
                    producibleUnits = Math.min(producibleUnits, maxByThisInput);
                });

                if (producibleUnits <= 0) {
                    // No hay insumos suficientes: no producir ni consumir
                    return;
                }

                // Consumir insumos
                Object.keys(recipe).forEach(inputKey => {
                    const requiredPerUnit = recipe[inputKey] || 0;
                    if (requiredPerUnit <= 0) return;
                    newResources[inputKey] = (newResources[inputKey] || 0) - (requiredPerUnit * producibleUnits);
                });

                // Añadir producto final
                newResources[k] = (newResources[k] || 0) + producibleUnits;
            });
            // aplicar las sumas fijas por tick también
            newResources.wood = (newResources.wood || 0) + extraWood;
            newResources.stone = (newResources.stone || 0) + extraStone;

            // Asegurar no negativos para recursos sensibles (ej: food)
            if (typeof newResources.food === 'number') newResources.food = Math.max(0, newResources.food);

            // 🔹 Guardar nuevas cantidades usando la función que opera con el client actual
            // Reutilizamos setResourcesWithClient (que actualmente solo actualiza wood/stone/food)
            // Para soportar recursos dinámicos, llamamos a una nueva función genérica que actualice cualquier recurso.
            await require('../utils/resourcesService').setResourcesWithClientGeneric(client, entityId, newResources);

    // Ajuste de población escalado por número de ticks pasados
    let newPopulation = popStats.current_population;
        if (ticks > 0) {
            const perTickProduction = calculateProduction(buildings, popStats);
            if ((perTickProduction.food || 0) >= 0) {
                newPopulation = Math.min(maxPopulation, newPopulation + POPULATION_CHANGE_RATE * ticks);
            } else {
                newPopulation = Math.max(1, newPopulation - POPULATION_CHANGE_RATE * ticks);
            }
        }

        // Persistir cambios y actualizar last_resource_update
            // Persist new population into populations table (we'll update the 'poor' bucket as a simple default)
            try {
                const totalMax = popSummary.max || popSummary.total || 0;
                // available = current - occupation (clamped at 0)
                const available = Math.max(0, newPopulation - occupation);
                // update 'poor' current_population and recompute available_population for that type
                await populationService.setPopulationForTypeWithClient(client, entityId, 'poor', newPopulation, totalMax, available);
            } catch (pErr) {
                console.warn('Failed to persist population to populations table:', pErr.message);
            }

            // Update last_resource_update in entities
            await client.query(
                `UPDATE entities
                 SET last_resource_update = $1
                 WHERE id = $2`,
                [now.toISOString(), entityId]
            );

        await client.query('COMMIT');

        // Return full response similar to previous /generate-resources API
        return {
            message: 'Recursos actualizados correctamente.',
            entity: {
                id: entity.id,
                faction_id: entity.faction_id || null,
                faction_name: faction_name || '',
                x_coord: entity.x_coord || 0,
                y_coord: entity.y_coord || 0,
                current_population: newPopulation,
                max_population: maxPopulation,
                resources: newResources
            },
            population: {
                current_population: newPopulation,
                max_population: maxPopulation,
                available_population: Math.max(0, newPopulation - occupation)
            }
        };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        console.error('Error processing user in resourceGenerator:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Función principal que recorre a todos los usuarios y procesa sus recursos.
 * Se ejecuta una sola vez por llamada (no usa timers internos).
 */
async function runResourceGeneratorJob() {
    try {
        console.log("-> Iniciando cálculo de recursos para todos los jugadores.");
        // Obtener lista de usuarios
        const res = await pool.query('SELECT id FROM entities');
        // Usamos Promise.all para procesar los usuarios en paralelo y terminar más rápido.
        // Si tienes miles de usuarios, considera limitar la concurrencia (ej: a 100).
        const results = await Promise.all(res.rows.map(row => processEntity(row.id, currentOptions).catch(err => ({ error: err.message, entityId: row.id }))));

        console.log("-> Generación de recursos completada.");
        return results;
    } catch (err) {
        console.error('Error running resource generator job:', err.message);
    }
}

module.exports = {
    runResourceGeneratorJob
};

// Also export single-entity processor for API usage
module.exports.processEntity = processEntity;

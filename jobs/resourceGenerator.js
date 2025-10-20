const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration, TICK_SECONDS, RESOURCE_GENERATOR_WOOD_PER_TICK, RESOURCE_GENERATOR_STONE_PER_TICK, FOOD_CONSUMPTION_PER_CITIZEN } = require('../utils/gameUtils');
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
    let resourceDeltas = null;
    try {
        await client.query('BEGIN');


      // 🔹 Obtener datos base de la entidad mediante entityService (bloquea si forUpdate=true)
         const entityService = require('../utils/entityService');
          const entity = await entityService.getEntityById(client, entityId, true);
            if (!entity) {
                    await client.query('ROLLBACK');
                       return;
                        }
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
    // If last_resource_update is missing, treat it as one tick ago so the
    // generator will process at least one tick on first run instead of
    // returning early because secondsElapsed would be 0.
    const last = entity.last_resource_update
        ? new Date(entity.last_resource_update)
        : new Date(Date.now() - (TICK_SECONDS * 1000));
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
    const accrued = calculateProductionForDuration(buildings, popStats, secondsElapsed, faction_name);
    const maxPopulation = popStats.max_population || entity.max_population || 0;

        // Aplicar sumas fijas por tick configurables
        const woodPerTick = options && options.woodPerTick ? parseFloat(options.woodPerTick) : 0;
        const stonePerTick = options && options.stonePerTick ? parseFloat(options.stonePerTick) : 0;

        const ticks = Math.floor(secondsElapsed / TICK_SECONDS);
        const extraWood = ticks * Math.floor(woodPerTick);
        const extraStone= ticks * Math.floor(stonePerTick);

            // 🔹 Cargar inventario de recursos usando el servicio (client-aware)
            const resourcesService = require('../utils/resourcesService');
            // Lock resource rows for this entity to keep reads/writes consistent within the transaction
            await resourcesService.lockResourceRowsWithClient(client, entityId);
            const currentResources = await resourcesService.getResourcesWithClient(client, entityId);

            // 🔹 Actualizar cantidades para todas las claves producidas
            let produced = accrued || {};
            const newResources = { ...currentResources };

            // --- Consumo de recursos por población (se ejecuta antes de la producción) ---
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

            // Load per-type population rows via populationService so logic is centralized
            const popMap = await populationService.getPopulationRowsWithClient(client, entityId);

            const tryConsumeForType = (typeKey, resourceKeys) => {
                const cur = popMap[typeKey]?.current || 0;
                const max = popMap[typeKey]?.max || 0;

                // For population maintenance/growth we only require food for the 'poor' bucket.
                // Other buckets (burgess/patrician) may depend on processed/special resources,
                // but requiring every possible resource is too strict. Use sensible defaults.
                let keysForBucket = resourceKeys;
                if (typeKey === 'poor') {
                    keysForBucket = ['food'];
                } else if (typeKey === 'burgess') {
                    keysForBucket = resourceKeys.length > 0 ? resourceKeys : ['lumber'];
                } else if (typeKey === 'patrician') {
                    keysForBucket = resourceKeys.length > 0 ? resourceKeys : ['spice'];
                }

                // Helper: check if we have at least n units in ANY of the provided keys
                const haveAtLeastInAny = (n) => keysForBucket.length > 0 && keysForBucket.some(k => (newResources[k] || 0) >= n);

                // If there is currently no population of this type, allow growth by consuming 1 unit
                // of a representative resource for the bucket (food for poor, any processed for burgess, ...)
                if (cur <= 0) {
                    if (max > 0 && haveAtLeastInAny(1)) {
                        // Consume 1 unit from the first available key that has stock
                        for (const k of keysForBucket) {
                            if ((newResources[k] || 0) >= 1) { newResources[k] = Math.max(0, (newResources[k] || 0) - 1); break; }
                        }
                        return { newCurrent: 1, max };
                    }
                    return { newCurrent: 0, max };
                }

                // Maintenance: compute required food consumption (applies to poor bucket only)
                const required = typeKey === 'poor' ? Math.max(0, Math.ceil((cur * (secondsElapsed / 60) * (FOOD_CONSUMPTION_PER_CITIZEN || 1)))) : 0;

                if (required <= 0) {
                    // No maintenance required in this interval
                    // Still allow growth if capacity and at least 1 unit of a representative resource remains
                    let newCurNoMaint = cur;
                    if ((max - cur) > 0 && haveAtLeastInAny(1)) {
                        for (const k of keysForBucket) {
                            if ((newResources[k] || 0) >= 1) { newResources[k] = Math.max(0, (newResources[k] || 0) - 1); newCurNoMaint = Math.min(max, cur + 1); break; }
                        }
                    }
                    return { newCurrent: newCurNoMaint, max };
                }

                // If not enough for full maintenance (only applies to poor), lose one population unit
                if (typeKey === 'poor' && (newResources['food'] || 0) < required) {
                    const newCur = Math.max(0, cur - 1);
                    return { newCurrent: newCur, max };
                }

                // Consume maintenance resources (food only for poor)
                if (typeKey === 'poor') {
                    newResources['food'] = Math.max(0, (newResources['food'] || 0) - required);
                }

                // Growth: if capacity and at least 1 unit of a representative resource remains, grow by 1
                let newCur = cur;
                if ((max - cur) > 0 && haveAtLeastInAny(1)) {
                    for (const k of keysForBucket) {
                        if ((newResources[k] || 0) >= 1) { newResources[k] = Math.max(0, (newResources[k] || 0) - 1); newCur = Math.min(max, cur + 1); break; }
                    }
                }
                return { newCurrent: newCur, max };
            };

            const poorRes = tryConsumeForType('poor', COMMON_RES);
            const burgessRes = tryConsumeForType('burgess', PROCESSED_RES);
            const patricianRes = tryConsumeForType('patrician', SPECIAL_RES);

            // Persist updated population rows for each type
            try {
                // occupation is an object like { poor, burgess, patrician, total }
                const occPoor = (occupation && Number.isFinite(Number(occupation.poor)) ? Number(occupation.poor) : 0);
                const occBurgess = (occupation && Number.isFinite(Number(occupation.burgess)) ? Number(occupation.burgess) : 0);
                const occPatrician = (occupation && Number.isFinite(Number(occupation.patrician)) ? Number(occupation.patrician) : 0);

                if (poorRes.newCurrent !== undefined) {
                    console.debug('updating poor population bucket');
                    await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'poor', poorRes.newCurrent, poorRes.max || 0);
                    // update local popMap as well
                    popMap.poor = { current: poorRes.newCurrent, max: poorRes.max || 0 };
                }
                if (burgessRes.newCurrent !== undefined) {
                    await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'burgess', burgessRes.newCurrent, burgessRes.max || 0);
                    popMap.burgess = { current: burgessRes.newCurrent, max: burgessRes.max || 0 };
                }
                if (patricianRes.newCurrent !== undefined) {
                    await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'patrician', patricianRes.newCurrent, patricianRes.max || 0);
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

            // Asegurar que ningún recurso sea negativo (clamp a 0)
            Object.keys(newResources).forEach(k => {
                if (typeof newResources[k] === 'number') newResources[k] = Math.max(0, newResources[k]);
            });

            // Compute deltas (new - old) and log added/subtracted resources per entity
            try {
                const deltas = {};
                const produced = {};
                const consumed = {};
                const allKeys = new Set([...(Object.keys(currentResources || {})), ...(Object.keys(newResources || {}))]);
                for (const k of allKeys) {
                    const oldV = Number(currentResources && currentResources[k] ? currentResources[k] : 0);
                    const newV = Number(newResources && newResources[k] ? newResources[k] : 0);
                    const diff = newV - oldV;
                    if (diff !== 0) {
                        deltas[k] = diff;
                        if (diff > 0) produced[k] = diff;
                        else consumed[k] = Math.abs(diff);
                    }
                }
                resourceDeltas = Object.keys(deltas).length > 0 ? deltas : null;
                // also expose produced/consumed separately for clearer logs
                resourceProduced = Object.keys(produced).length > 0 ? produced : null;
                resourceConsumed = Object.keys(consumed).length > 0 ? consumed : null;
            } catch (logErr) {
                console.warn('Failed to compute resource deltas for entity', entityId, logErr && logErr.message);
                resourceDeltas = null;
                resourceProduced = null;
                resourceConsumed = null;
            }

            // 🔹 Guardar nuevas cantidades usando la función que opera con el client actual
            // Para soportar recursos dinámicos, llamamos a la función genérica que actualice cualquier recurso.
            const rs = require('../utils/resourcesService');
            try {
                // Debug snapshot: current/new
                console.debug(`[RESOURCE_GEN][DEBUG] entity=${entityId} currentResources snapshot:`, currentResources);
                console.debug(`[RESOURCE_GEN][DEBUG] entity=${entityId} newResources intent:`, newResources);
                await rs.setResourcesWithClientGeneric(client, entityId, newResources);
                const after = await rs.getResourcesWithClient(client, entityId);
                console.debug(`[RESOURCE_GEN][DEBUG] entity=${entityId} afterResources snapshot:`, after);
            } catch (saveErr) {
                console.warn(`[RESOURCE_GEN] Failed to save resources for entity=${entityId}:`, saveErr && saveErr.message);
                throw saveErr;
            }

    // Ajuste de población escalado por número de ticks pasados
    // Use the recently-updated per-type population (popMap.poor.current) if available
    // to avoid overwriting the increment we just persisted above.
    let newPopulation = (popMap && popMap.poor && Number.isFinite(Number(popMap.poor.current))) ? Number(popMap.poor.current) : popStats.current_population;
        if (ticks > 0) {
            const perTickProduction = calculateProduction(buildings, popStats, faction_name);
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
                // update 'poor' current_population and recompute available_population for that type
                await populationService.setPopulationForTypeComputedWithClient(client, entityId, 'poor', newPopulation, totalMax);
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
            },
            // Provide resource deltas for centralized logging in runResourceGeneratorJob
            resource_deltas: resourceDeltas,
            resource_produced: typeof resourceProduced !== 'undefined' ? resourceProduced : null,
            resource_consumed: typeof resourceConsumed !== 'undefined' ? resourceConsumed : null
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
    console.debug("-> Iniciando cálculo de recursos para todos los jugadores.");
        // Obtener lista de usuarios usando entityService
    const entityService = require('../utils/entityService');
    const ids = await entityService.listAllEntityIds(pool);
    // Usamos Promise.all para procesar los usuarios en paralelo y terminar más rápido.
    // Si tienes miles de usuarios, considera limitar la concurrencia (ej: a 100).
    const results = await Promise.all(ids.map(id => processEntity(id, currentOptions).catch(err => ({ error: err.message, entityId: id }))));

    // Centralized logging of resource deltas produced/consumed per entity
    try {
        for (const r of results || []) {
            if (!r) continue;
            const entityIdLog = (r.entity && r.entity.id) || r.entityId || null;
            if (entityIdLog) {
                // Always show produced/consumed explicitly (null or object) so logs are consistent
                console.debug(`[RESOURCE_GEN] entity=${entityIdLog} produced:`, r.resource_produced || null);
                console.debug(`[RESOURCE_GEN] entity=${entityIdLog} consumed:`, r.resource_consumed || null);
                // If we have produced but no consumed, also print raw deltas for debugging
                if (r.resource_produced && !r.resource_consumed && r.resource_deltas) {
                    console.debug(`[RESOURCE_GEN] entity=${entityIdLog} deltas (debug):`, r.resource_deltas);
                }
            }
        }
    } catch (logAllErr) {
        console.warn('Failed to emit centralized resource delta logs:', logAllErr && logAllErr.message);
    }

    console.debug("-> Generación de recursos completada.");
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

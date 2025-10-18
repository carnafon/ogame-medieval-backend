const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration, TICK_SECONDS, RESOURCE_GENERATOR_WOOD_PER_TICK, RESOURCE_GENERATOR_STONE_PER_TICK } = require('../utils/gameUtils');
const { getBuildings } = require('../utils/buildingsService');

// Parámetros configurables
const POPULATION_CHANGE_RATE = 1; // cambio de población por tick

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
                `SELECT id, type, current_population, last_resource_update, faction_id, x_coord, y_coord, max_population
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

    // Calcular población y producción acumulada
    const populationService = require('../utils/populationService');
    const popSummary = await populationService.getPopulationSummaryWithClient(client, entityId);
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
                const available = Math.max(0, totalMax - newPopulation);
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
                available_population: maxPopulation - newPopulation
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

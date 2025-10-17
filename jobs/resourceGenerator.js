const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration, TICK_SECONDS, RESOURCE_GENERATOR_WOOD_PER_TICK, RESOURCE_GENERATOR_STONE_PER_TICK } = require('../utils/gameUtils');

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


        // 🔹 Obtener datos base de la entidad (lock para evitar race conditions)
    const entityRes = await client.query(
      'SELECT id, type, current_population, last_resource_update FROM entities WHERE id = $1 FOR UPDATE',
      [entityId]
    );

    if (entityRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const entity = entityRes.rows[0];
    const last = entity.last_resource_update ? new Date(entity.last_resource_update) : new Date();
    const now = new Date();
    const secondsElapsed = Math.max(0, Math.floor((now - last) / 1000));
    if (secondsElapsed <= 0) {
      await client.query('COMMIT');
      return;
    }




        // Obtener edificios del usuario
        const bRes = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE entity_id  = $1 GROUP BY type',
            [entityId]
        );
        const buildings = bRes.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));

        // Calcular población y producción acumulada
        const popStats = calculatePopulationStats(buildings, parseInt(entity.current_population, 10));
        const accrued = calculateProductionForDuration(buildings, popStats, secondsElapsed);

        // Aplicar sumas fijas por tick configurables
        const woodPerTick = options && options.woodPerTick ? parseFloat(options.woodPerTick) : 0;
        const stonePerTick = options && options.stonePerTick ? parseFloat(options.stonePerTick) : 0;

        const ticks = Math.floor(secondsElapsed / TICK_SECONDS);
        const extraWood = ticks * Math.floor(woodPerTick);
        const extraStone= ticks * Math.floor(stonePerTick);

        // 🔹 Cargar inventario de recursos usando el servicio
        const currentResources = await require('../utils/resourcesService').getResources(entityId);

        // 🔹 Actualizar cantidades
        const newResources = {
            wood: (currentResources.wood || 0) + (accrued.wood || 0) + extraWood,
            stone: (currentResources.stone || 0) + (accrued.stone || 0) + extraStone,
            food: Math.max(0, (currentResources.food || 0) + (accrued.food || 0)),
        };

        // 🔹 Guardar nuevas cantidades usando la función que opera con el client actual
        await require('../utils/resourcesService').setResourcesWithClient(client, entityId, newResources);

        // Ajuste de población escalado por número de ticks pasados
        let newPopulation = popStats.current_population;
        const maxPopulation = popStats.max_population;
        if (ticks > 0) {
            const perTickProduction = calculateProduction(buildings, popStats);
            if ((perTickProduction.food || 0) >= 0) {
                newPopulation = Math.min(maxPopulation, newPopulation + POPULATION_CHANGE_RATE * ticks);
            } else {
                newPopulation = Math.max(1, newPopulation - POPULATION_CHANGE_RATE * ticks);
            }
        }

        // Persistir cambios y actualizar last_resource_update
      await client.query(
      `
      UPDATE entities
      SET current_population = $1, last_resource_update = $2
      WHERE id = $3
      `,
      [newPopulation, now.toISOString(), entityId]
    );

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        console.error('Error processing user in resourceGenerator:', err.message);
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
        await Promise.all(res.rows.map(row => processEntity(row.id, currentOptions)));

        console.log("-> Generación de recursos completada.");
    } catch (err) {
        console.error('Error running resource generator job:', err.message);
    }
}

module.exports = {
    runResourceGeneratorJob
};

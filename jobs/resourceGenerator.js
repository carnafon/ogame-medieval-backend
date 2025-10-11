const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration, TICK_SECONDS, RESOURCE_GENERATOR_WOOD_PER_TICK, RESOURCE_GENERATOR_STONE_PER_TICK } = require('../utils/gameUtils');

// Parámetros configurables
const POPULATION_CHANGE_RATE = 1; // cambio de población por tick

// Opciones por defecto que la tarea usará
const currentOptions = {
    woodPerTick: RESOURCE_GENERATOR_WOOD_PER_TICK,
    stonePerTick: RESOURCE_GENERATOR_STONE_PER_TICK
};

// Función helper para procesar la lógica de recursos de un solo usuario
async function processUser(userId, options) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query(
            'SELECT wood, stone, food, current_population, last_resource_update FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return;
        }

        const dbRow = userRes.rows[0];
        const last = dbRow.last_resource_update ? new Date(dbRow.last_resource_update) : new Date();
        const now = new Date();
        const secondsElapsed = Math.max(0, Math.floor((now - last) / 1000));
        if (secondsElapsed <= 0) {
            await client.query('COMMIT');
            return;
        }

        // Obtener edificios del usuario
        const bRes = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type',
            [userId]
        );
        const buildings = bRes.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));

        // Calcular población y producción acumulada
        const popStats = calculatePopulationStats(buildings, parseInt(dbRow.current_population, 10));
        const accrued = calculateProductionForDuration(buildings, popStats, secondsElapsed);

        // Aplicar sumas fijas por tick configurables
        const woodPerTick = options && options.woodPerTick ? parseFloat(options.woodPerTick) : 0;
        const stonePerTick = options && options.stonePerTick ? parseFloat(options.stonePerTick) : 0;

        const ticks = Math.floor(secondsElapsed / TICK_SECONDS);
        const extraWoodFromFixed = ticks * Math.floor(woodPerTick);
        const extraStoneFromFixed = ticks * Math.floor(stonePerTick);

        let newWood = parseInt(dbRow.wood, 10) + accrued.wood + extraWoodFromFixed;
        let newStone = parseInt(dbRow.stone, 10) + accrued.stone + extraStoneFromFixed;
        let newFood = Math.max(0, parseInt(dbRow.food, 10) + accrued.food);

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
            `UPDATE users SET wood = $1, stone = $2, food = $3, current_population = $4, last_resource_update = $5 WHERE id = $6`,
            [newWood, newStone, newFood, newPopulation, now.toISOString(), userId]
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
        const res = await pool.query('SELECT id FROM users');
        // Usamos Promise.all para procesar los usuarios en paralelo y terminar más rápido.
        // Si tienes miles de usuarios, considera limitar la concurrencia (ej: a 100).
        await Promise.all(res.rows.map(row => processUser(row.id, currentOptions)));

        console.log("-> Generación de recursos completada.");
    } catch (err) {
        console.error('Error running resource generator job:', err.message);
    }
}

module.exports = {
    runResourceGeneratorJob
};

const pool = require('../db');
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration } = require('../utils/gameUtils');

// Parámetros configurables
const DEFAULT_INTERVAL_SECONDS = 10; // cada cuánto se ejecuta el job
const POPULATION_CHANGE_RATE = 1; // cambio de población por tick
const TICK_SECONDS = 10; // debe coincidir con gameUtils TICK_SECONDS

let intervalHandle = null;

async function processUser(userId) {
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

        let newWood = parseInt(dbRow.wood, 10) + accrued.wood;
        let newStone = parseInt(dbRow.stone, 10) + accrued.stone;
        let newFood = Math.max(0, parseInt(dbRow.food, 10) + accrued.food);

        // Ajuste de población escalado por número de ticks pasados
        const ticks = Math.floor(secondsElapsed / TICK_SECONDS);
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

async function runOnce() {
    try {
        // Obtener lista de usuarios
        const res = await pool.query('SELECT id FROM users');
        for (const row of res.rows) {
            // procesar secuencialmente para evitar sobrecargar la DB; si quieres paralelizar, limitar concurrency
            // No await aquí sería paralelizar, pero lo dejamos secuencial por simplicidad y seguridad.
            await processUser(row.id);
        }
    } catch (err) {
        console.error('Error running resource generator job:', err.message);
    }
}

function startResourceGenerator(options = {}) {
    const intervalSeconds = options.intervalSeconds || DEFAULT_INTERVAL_SECONDS;
    if (intervalHandle) return;
    // Ejecutar inmediatamente y luego cada intervalo
    runOnce().catch(err => console.error('Initial resource generator run failed:', err.message));
    intervalHandle = setInterval(() => {
        runOnce().catch(err => console.error('Resource generator run failed:', err.message));
    }, intervalSeconds * 1000);
    console.log(`Resource generator started, interval ${intervalSeconds}s`);
}

function stopResourceGenerator() {
    if (!intervalHandle) return;
    clearInterval(intervalHandle);
    intervalHandle = null;
}

module.exports = {
    startResourceGenerator,
    stopResourceGenerator,
    // exportamos runOnce para tests o ejecuciones manuales
    runOnce
};

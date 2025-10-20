/**
 * run_ai_job.js
 * * Script de ejecución que debe ser llamado por tu sistema de tareas programadas (Cron).
 */

const pool = require('./db'); // Asume que db.js exporta la instancia del Pool
const { runBatch } = require('./jobs/ai_economic_engine_v2');

async function main() {
    console.log("Iniciando tarea programada de actualización de IA...");
    try {
        await runBatch(pool, { maxCitiesPerTick: 40, concurrency: 6 });
        console.log("Tarea de IA (v2) finalizada con éxito.");
    } catch (error) {
        console.error("Error al ejecutar la tarea de IA:", error);
    } finally {
        // Cierra la conexión o mantén el pool abierto si es una función recurrente
        // Si este script se ejecuta y termina, usa: pool.end();
    }
}

// Ejecutar el script
// Debes configurarlo para que se ejecute cada X minutos (e.g., usando node-cron o un cron job del sistema)
// main(); 
// console.log("¡El motor AI está listo para ser activado por tu CRON job!");

module.exports = { main }; // Exportar si usas un orquestador de jobs

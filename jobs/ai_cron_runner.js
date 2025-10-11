/**
 * ai_cron_runner.js
 * * Punto de entrada único para el Cron Job de Render.
 * 1. Inicializa la conexión a PostgreSQL usando variables de entorno.
 * 2. Ejecuta el motor económico de la IA (importado desde ./ai_economic_engine).
 * 3. Cierra el pool al finalizar la tarea.
 */

// Importar la librería de PostgreSQL. Asume que 'pg' está instalado.
const { Pool } = require('pg'); 
// Importar la lógica principal del motor económico.
const { runEconomicUpdate } = require('./ai_economic_engine');

// --- CONFIGURACIÓN DEL POOL DE CONEXIÓN ---
// Render automáticamente expone la URL de tu base de datos en las variables de entorno.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Reemplaza con tu variable si es diferente
    ssl: {
        rejectUnauthorized: false // Es común en Render usar esta configuración para SSL
    }
});

// --- FUNCIÓN PRINCIPAL DE EJECUCIÓN ---
async function main() {
    console.log(`[CRON JOB] Iniciando tarea de actualización de IA en ${new Date().toISOString()}`);
    
    try {
        // 1. Ejecutar el motor de la IA, pasándole el pool de conexión.
        await runEconomicUpdate(pool);
        
        console.log("[CRON JOB] Tarea de IA finalizada con éxito.");
    } catch (error) {
        console.error("[CRON JOB] ERROR CRÍTICO al ejecutar la tarea de IA:", error.message);
        // Indicar al sistema que hubo un error
        process.exit(1); 
    } finally {
        // 2. Cerrar la conexión para liberar recursos. Esto es CRÍTICO en un cron job.
        await pool.end();
    }
}

// Ejecutar el script.
main();

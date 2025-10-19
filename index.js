require('dotenv').config();
const express = require('express');
const cors = require('cors'); 
const pool = require('./db'); // Importamos la conexión
const authRoutes = require('./routes/authRoutes'); // Importamos rutas de Autenticación
const gameRoutes = require('./routes/gameRoutes'); // Importamos rutas del Juego

// ⭐️ Importamos el middleware de autenticación desde su archivo dedicado
const { authenticateToken } = require('./middleware/auth'); 

// ⭐️ Importamos la función que ejecuta la lógica UNA SOLA VEZ
// Asumimos que la lógica está en este archivo y exporta una función 'runResourceGeneratorJob'
const { runResourceGeneratorJob } = require('./jobs/resourceGenerator'); 

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3000;

// Middleware para verificar la conexión a la DB
pool.connect()
    .then((client) => {
        // Immediately release the client to avoid holding onto a checked-out client.
        try { client.release(); } catch (e) { /* ignore */ }
        console.log('✅ Conectado a la base de datos de Neon.');
        // ❌ Importante: Hemos eliminado el código que llamaba a startResourceGenerator,
        // ya que ahora la tarea se ejecutará solo bajo demanda del Web-Cron.
    })
    .catch(err => console.error('❌ Error de conexión a la base de datos:', err.message));


// -----------------------------------------------------------------
// --- RUTAS DE WEB-CRON (GRATUITAS) ---
// -----------------------------------------------------------------

// Ruta secreta para ejecutar el job de generación de recursos
app.post('/api/run-scheduled-job', async (req, res) => {
    // 1. Verificación de Seguridad: Comprueba el secreto en el query parameter 'key'
    const secret = process.env.AI_CRON_SECRET;
    const receivedSecret = req.query.key; 

    if (!secret || receivedSecret !== secret) {
        console.error('[WEB-CRON] Intento de acceso no autorizado o secreto incorrecto.');
        return res.status(401).json({ message: 'Acceso denegado. Secreto incorrecto.' });
    }
    
        // 2. Ejecutar la Tarea
        console.log(`[WEB-CRON] Iniciando tarea de generación de recursos a las ${new Date().toISOString()}`);
        try {
            // La función runResourceGeneratorJob (del archivo jobs/resourceGenerator.js)
            // se encargará de toda la lógica de cálculo de recursos para los jugadores.
            await runResourceGeneratorJob();

            // También intentamos ejecutar la actualización económica de las ciudades IA
            try {
                // Prefer v2 when configured; fallback to v1 on error/timeout
                const preferred = process.env.AI_ENGINE_VERSION || 'auto'; // '1' | '2' | 'auto'
                const v2Percent = Number(process.env.AI_V2_RUN_PERCENT || 0);
                const AI_TIMEOUT_MS = Number(process.env.AI_TX_TIMEOUT_MS || 30000);

                const tryRunV2 = async () => {
                    try {
                        const ai2 = require('./jobs/ai_economic_engine_v2');
                        if (!ai2 || typeof ai2.runBatch !== 'function') throw new Error('v2 missing runBatch');
                        // options: maxCitiesPerTick, runPercent
                        const opts = { maxCitiesPerTick: Number(process.env.AI_MAX_CITIES_PER_TICK || 40), runPercent: v2Percent };
                        return await ai2.runBatch(pool, opts);
                    } catch (e) {
                        throw e;
                    }
                };

                const runV1 = async () => {
                    const ai1 = require('./jobs/ai_economic_engine');
                    if (!ai1 || typeof ai1.runEconomicUpdate !== 'function') throw new Error('v1 missing runEconomicUpdate');
                    return await ai1.runEconomicUpdate(pool);
                };

                const promiseWithTimeout = (p, ms) => new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('AI engine timeout')), ms);
                    p.then(r => { clearTimeout(t); resolve(r); }).catch(err => { clearTimeout(t); reject(err); });
                });

                let usedV2 = false;
                if (preferred === '2' || (preferred === 'auto' && v2Percent > 0 && Math.random() * 100 < v2Percent)) {
                    try {
                        console.log('[WEB-CRON] Running AI engine v2 (canary)');
                        await promiseWithTimeout(tryRunV2(), AI_TIMEOUT_MS);
                        usedV2 = true;
                        console.log('[WEB-CRON] AI v2 finished');
                    } catch (err) {
                        console.error('[WEB-CRON] AI v2 failed or timed out:', err && err.message);
                        // fallback to v1 below
                    }
                }

                if (!usedV2) {
                    try {
                        console.log('[WEB-CRON] Running AI engine v1 (legacy)');
                        await promiseWithTimeout(runV1(), AI_TIMEOUT_MS);
                        console.log('[WEB-CRON] AI v1 finished');
                    } catch (err) {
                        console.error('[WEB-CRON] AI v1 failed or timed out:', err && err.message);
                    }
                }

            } catch (aiErr) {
                // Log but don't fail the whole endpoint if AI engine has an issue
                console.error('[WEB-CRON] Error ejecutando AI economic engine:', aiErr && aiErr.stack ? aiErr.stack : aiErr);
            }

            console.log('[WEB-CRON] Tarea finalizada con éxito.');
            // 3. Responder al servicio Web-Cron (ej. Cron-Job.org)
            res.status(200).json({ message: 'Tarea de generación de recursos y AI ejecutada.' });

        } catch (error) {
            console.error('[WEB-CRON] Error durante la ejecución de la tarea:', error);
            res.status(500).json({ message: 'Error interno al ejecutar la tarea programada.', error: error.message });
        }
});


// -----------------------------------------------------------------
// --- RUTAS DE APLICACIÓN ---
// -----------------------------------------------------------------

// Ruta principal para verificar que el servidor está funcionando
app.get('/', (req, res) => {
    res.send('Servidor de OGame Medieval está en línea.');
});

//rutas de facciones (publico)
const factionRoutes = require('./routes/factionRoutes');
app.use('/api/factions', factionRoutes);

// Rutas de Autenticación (Login, Register, Me)
app.use('/api', authRoutes); 

// Rutas del Juego (Build, Generate-Resources)
app.use('/api', authenticateToken, gameRoutes); 

//rutas de entidades
const entitiesRoutes = require('./routes/entitiesRoutes');
app.use('/api/entities', entitiesRoutes);

// Routes for entity buildings
const entitiesBuildingsRoutes = require('./routes/entitiesBuildingsRoutes');
app.use('/api/entities', entitiesBuildingsRoutes);

// rutas de recursos (GET/POST)
const resourcesRoutes = require('./routes/resourcesRoutes');
app.use('/api/resources', resourcesRoutes);

// rutas de población
const populationRoutes = require('./routes/populationRoutes');
app.use('/api/population', populationRoutes);




app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

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
    .then(() => {
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
        
        console.log('[WEB-CRON] Tarea finalizada con éxito.');
        // 3. Responder al servicio Web-Cron (ej. Cron-Job.org)
        res.status(200).json({ message: 'Tarea de generación de recursos ejecutada.' });

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

// Rutas de Autenticación (Login, Register, Me)
app.use('/api', authRoutes); 

// Rutas del Juego (Build, Generate-Resources)
app.use('/api', authenticateToken, gameRoutes); 

//rutas de entidades
const entitiesRoutes = require('./routes/entitiesRoutes');
app.use('/api/entities', entitiesRoutes);

app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

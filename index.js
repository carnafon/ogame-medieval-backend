require('dotenv').config();
const express = require('express');
const cors = require('cors'); 
const pool = require('./db'); // Importamos la conexión
const authRoutes = require('./routes/authRoutes'); // Importamos rutas de Autenticación
const gameRoutes = require('./routes/gameRoutes'); // Importamos rutas del Juego

// ⭐️ Importamos el middleware de autenticación desde su archivo dedicado
const { authenticateToken } = require('./middleware/auth'); 

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3000;

// Middleware para verificar la conexión a la DB
pool.connect()
  .then(() => console.log('✅ Conectado a la base de datos de Neon.'))
  .catch(err => console.error('❌ Error de conexión a la base de datos:', err.message));


// -----------------------------------------------------------------
// --- RUTAS ---
// -----------------------------------------------------------------

// Ruta principal para verificar que el servidor está funcionando
app.get('/', (req, res) => {
  res.send('Servidor de OGame Medieval está en línea.');
});

// Rutas de Autenticación (Login, Register, Me)
app.use('/api', authRoutes); 

// Rutas del Juego (Build, Generate-Resources)
// Usamos el middleware de autenticación aquí para proteger todas las rutas de juego
// gameRoutes ahora exporta solo el router, por eso no necesita desestructuración.
app.use('/api', authenticateToken, gameRoutes); 

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});

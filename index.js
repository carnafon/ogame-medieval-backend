// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors'); // Necesario para que el frontend pueda comunicarse con el backend

const app = express();
app.use(express.json());
app.use(cors());

// Conexión a la base de datos de Neon a través de la variable de entorno de Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Comprueba la conexión a la base de datos
pool.connect()
  .then(() => console.log('Conectado a la base de datos de Neon.'))
  .catch(err => console.error('Error de conexión a la base de datos:', err.message));

// Ruta principal para verificar que el servidor está funcionando
app.get('/', (req, res) => {
  res.send('Servidor de OGame Medieval está en línea.');
});

// Ruta para registrar un nuevo usuario
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  try {
    const newUser = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *',
      [username, password]
    );
    res.status(201).json({
      message: 'Usuario registrado con éxito.',
      user: newUser.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'El nombre de usuario ya existe.' });
    }
    res.status(500).json({ message: 'Error al registrar el usuario.', error: err.message });
  }
});

// Lógica de generación pasiva de recursos (se ejecuta cada minuto)
setInterval(async () => {
  try {
    const resourceGrowth = 1; // 1 unidad por minuto para empezar
    await pool.query(
      `UPDATE users SET
        wood = wood + ${resourceGrowth},
        stone = stone + ${resourceGrowth},
        food = food + ${resourceGrowth}`
    );
  } catch (err) {
    console.error('Error al actualizar recursos:', err.message);
  }
}, 60000); // 60,000 milisegundos = 1 minuto

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});
// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors'); // Necesario para que el frontend pueda comunicarse con el backend

const jwt = require('jsonwebtoken'); // <-- Añade esto al inicio de index.js
const JWT_SECRET = process.env.JWT_SECRET; // Obtiene el secreto del .env


const bcrypt = require('bcrypt');// Para hashear contraseñas 

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

// Función auxiliar para crear el token
const createToken = (userId, username) => {
    return jwt.sign(
        { id: userId, username: username }, 
        JWT_SECRET, 
        { expiresIn: '7d' } // Token válido por 7 días
    );
};

// Middleware para verificar el token (lo usaremos para validar la sesión)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Espera un formato "Bearer TOKEN"

    if (token == null) return res.sendStatus(401); // No autorizado

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); // Token inválido o expirado
        req.user = user; // El payload decodificado (id, username) se añade al request
        next();
    });
};
//DEFINIR COSTES DE CONSTRUCCIÓN
const BUILDING_COSTS = {
    'house': { wood: 20, stone: 10, food: 5 },
    // Aquí puedes añadir más edificios, ej: 'mine': { wood: 50, stone: 50, food: 10 }
};




// --- RUTAS DE AUTENTICACIÓN (Registro, Login) ---
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
  const saltRounds = 10;// Nivel de dificultad para el cifrado
  try {
    // 1. Cifrar (Hash) la contraseña
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newUser = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *',
      [username, hashedPassword]
    );
    const token = createToken(newUser.id, newUser.username); // Genera el token
    res.status(201).json({
      message: 'Usuario registrado con éxito.',
      user: newUser.rows[0],
      token: token 
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'El nombre de usuario ya existe.' });
    }
    res.status(500).json({ message: 'Error al registrar el usuario.', error: err.message });
  }

 
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. Buscar el usuario por nombre de usuario
    const userResult = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    const user = userResult.rows[0];

    // 2. Verificar si el usuario existe
    if (!user) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    }

    // 3. Verificar la contraseña (¡ADVERTENCIA: Aún no es segura!)
    // NOTA: Estamos comparando texto plano. En un proyecto real, usarías una librería
    // como bcrypt para verificar la contraseña hasheada: await bcrypt.compare(password, user.password)
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    }

    // 4. Login exitoso: devolver los datos del usuario y recursos
    const token = createToken(user.id, user.username); // Genera el token

    res.status(200).json({
      message: `¡Bienvenido de nuevo, ${user.username}!`,
      user: user,
      token: token // <-- ¡Ahora enviamos el token!
    });

  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión.', error: err.message });
  }
});

// --- RUTA /api/me (Validar Sesión y Obtener Datos) ---
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        // El middleware 'authenticateToken' ya verificó el token y nos dio el req.user.id
        const userResult = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [req.user.id]
        );

        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        
        // Devuelve los datos del usuario, manteniendo la sesión activa
        res.status(200).json({
            message: `Sesión reanudada para ${user.username}.`,
            user: user
        });

    } catch (err) {
        res.status(500).json({ message: 'Error al reanudar la sesión.', error: err.message });
    }
});

//RUTA CONSTRUCCION

app.post('/api/build', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { buildingType } = req.body; // Espera un 'buildingType': 'house', 'mine', etc.

    // 1. Verificar si el tipo de edificio es válido
    const cost = BUILDING_COSTS[buildingType];
    if (!cost) {
        return res.status(400).json({ message: 'Tipo de edificio no válido.' });
    }

    const client = await pool.connect(); // Usar pool para transacciones

    try {
        await client.query('BEGIN'); // Iniciar la transacción

        // 2. Obtener los recursos actuales del usuario
        const currentResources = await client.query(
            'SELECT wood, stone, food FROM users WHERE id = $1 FOR UPDATE', // Bloquear fila
            [userId]
        );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        const user = currentResources.rows[0];

        // 3. Verificar si hay suficientes recursos
        if (user.wood < cost.wood || user.stone < cost.stone || user.food < cost.food) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Recursos insuficientes para construir.' });
        }

        // 4. Deducir los recursos
        const updatedResources = await client.query(
            `UPDATE users SET
                wood = wood - $1,
                stone = stone - $2,
                food = food - $3
             WHERE id = $4
             RETURNING wood, stone, food, username`,
            [cost.wood, cost.stone, cost.food, userId]
        );

        const updatedUser = updatedResources.rows[0];

        // 5. Registrar el nuevo edificio
        await client.query(
            'INSERT INTO buildings (user_id, type) VALUES ($1, $2)',
            [userId, buildingType]
        );

        await client.query('COMMIT'); // Confirmar la transacción

        // 6. Obtener la lista de edificios (opcional, pero útil para el frontend)
        const buildingCountResult = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type',
            [userId]
        );

        const buildingsList = buildingCountResult.rows.map(row => ({
            type: row.type,
            count: parseInt(row.count, 10)
        }));


        res.status(200).json({
            message: `¡Construido con éxito! Has añadido 1 ${buildingType}.`,
            user: updatedUser,
            buildings: buildingsList // <-- Enviamos la lista de edificios
        });

    } catch (err) {
        await client.query('ROLLBACK'); // Deshacer si hay error
        res.status(500).json({ message: 'Error en la construcción.', error: err.message });
    } finally {
        client.release();
    }
});


////////////////////////////LOGICA DE RECURSOS PASIVOS////////////////////////////

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
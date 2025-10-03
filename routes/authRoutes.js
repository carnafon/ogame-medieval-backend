const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcrypt'); 
const { calculatePopulationStats } = require('../utils/gameUtils');
// ⭐️ Importación centralizada:
const { authenticateToken } = require('../middleware/auth'); 

const JWT_SECRET = process.env.JWT_SECRET;
const BASE_POPULATION = 10; 

// Función auxiliar para crear el token
const createToken = (userId, username) => {
    return jwt.sign(
        { id: userId, username: username }, 
        JWT_SECRET, 
        { expiresIn: '7d' } // Token válido por 7 días
    );
};


// -----------------------------------------------------------------
// --- RUTAS PÚBLICAS ---
// -----------------------------------------------------------------

// Ruta para registrar un nuevo usuario
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const saltRounds = 10;
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
      
    // Incluir current_population en la inserción y retorno
    const newUser = await pool.query(
      'INSERT INTO users (username, password, current_population) VALUES ($1, $2, $3) RETURNING id, username, wood, stone, food, current_population',
      [username, hashedPassword, BASE_POPULATION]
    );
      
    const token = createToken(newUser.rows[0].id, newUser.rows[0].username); 
    const buildingsList = []; 
    const populationStats = calculatePopulationStats(buildingsList, BASE_POPULATION);

    res.status(201).json({
      message: 'Usuario registrado con éxito.',
      user: {
            ...newUser.rows[0],
            wood: parseInt(newUser.rows[0].wood, 10),
            stone: parseInt(newUser.rows[0].stone, 10),
            food: parseInt(newUser.rows[0].food, 10),
            current_population: parseInt(newUser.rows[0].current_population, 10),
        },
      token: token,
      buildings: buildingsList,
      population: populationStats
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'El nombre de usuario ya existe.' });
    }
    res.status(500).json({ message: 'Error al registrar el usuario.', error: err.message });
  }
});

// Ruta para iniciar sesión
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const userResult = await pool.query(
      'SELECT id, username, password, wood, stone, food, current_population FROM users WHERE username = $1',
      [username]
    );

    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    }

    // Obtener edificios y calcular población
    const buildingCountResult = await pool.query(
        'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type', 
        [user.id]
    );

    const buildingsList = buildingCountResult.rows.map(row => ({
        type: row.type,
        count: parseInt(row.count, 10)
    }));

    const currentPop = parseInt(user.current_population, 10);
    const populationStats = calculatePopulationStats(buildingsList, currentPop);


    const token = createToken(user.id, user.username); 

    res.status(200).json({
      message: `¡Bienvenido de nuevo, ${user.username}!`,
      user: {
        id: user.id,
        username: user.username,
        wood: parseInt(user.wood, 10),
        stone: parseInt(user.stone, 10), 
        food: parseInt(user.food, 10),
        current_population: currentPop
      },
      buildings: buildingsList,
      population: populationStats, 
      token: token 
    });

  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión.', error: err.message });
  }
});

// --- RUTA /api/me (Validar Sesión y Obtener Datos) ---
// ⭐️ Esta ruta ahora usa el middleware importado
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
        
    const [userResult, buildingCountResult] = await Promise.all([
          pool.query('SELECT id, username, wood, stone, food, current_population FROM users WHERE id = $1', [userId]),
          pool.query('SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type', [userId])
    ]);

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }
  
    const buildingsList = buildingCountResult.rows.map(row => ({
        type: row.type,
        count: parseInt(row.count, 10)
    }));

    const currentPop = parseInt(user.current_population, 10);   
    const populationStats = calculatePopulationStats(buildingsList, currentPop);

    res.status(200).json({
      message: `Sesión reanudada para ${user.username}.`,
      user: {
                id: user.id,
                username: user.username,
                wood: parseInt(user.wood, 10), 
                stone: parseInt(user.stone, 10), 
                food: parseInt(user.food, 10),
                current_population: currentPop
            },
            buildings: buildingsList,
            population: populationStats
    });

  } catch (err) {
    res.status(500).json({ message: 'Error al reanudar la sesión.', error: err.message });
  }
});

module.exports = router;
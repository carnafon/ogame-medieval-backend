const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcrypt'); 
const { calculatePopulationStats, findAvailableCoordinates } = require('../utils/gameUtils');
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

// Ruta para registrar un nuevo usuario/asentamiento
router.post('/register', async (req, res) => {
    // ⭐️ AHORA ESPERAMOS factionId en el body
    const { username, password, factionId } = req.body; 
    const saltRounds = 10;

    // Validación de campos obligatorios
    if (!username || !password || !factionId) {
        return res.status(400).json({ message: 'Faltan campos: username, password y factionId son obligatorios.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        
        // ⭐️ 1. Encontrar coordenadas aleatorias y disponibles usando el factionId
        const { x, y } = await findAvailableCoordinates(pool, factionId); 

        // ⭐️ 2. Insertar el nuevo usuario, incluyendo faction_id, x_coord e y_coord
        const newUser = await pool.query(
            // El orden de los parámetros DEBE coincidir con el array de valores:
            'INSERT INTO users (username, password, faction_id, current_population, last_resource_update, x_coord, y_coord) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, wood, stone, food, current_population, last_resource_update, x_coord, y_coord, faction_id',
            [username, hashedPassword, factionId, BASE_POPULATION, new Date().toISOString(), x, y] // $3 = factionId, $6 = x, $7 = y
        );
        
        const token = createToken(newUser.rows[0].id, newUser.rows[0].username); 
        const buildingsList = []; 
        const populationStats = calculatePopulationStats(buildingsList, BASE_POPULATION);

        res.status(201).json({
            message: 'Asentamiento registrado con éxito.',
            user: {
                ...newUser.rows[0],
                wood: parseInt(newUser.rows[0].wood || 0, 10),
                stone: parseInt(newUser.rows[0].stone || 0, 10),
                food: parseInt(newUser.rows[0].food || 0, 10),
                current_population: parseInt(newUser.rows[0].current_population, 10),
                x_coord: parseInt(newUser.rows[0].x_coord, 10),
                y_coord: parseInt(newUser.rows[0].y_coord, 10),
                faction_id: parseInt(newUser.rows[0].faction_id, 10), // ⭐️ Retornamos el ID de facción
            },
            token: token,
            buildings: buildingsList,
            population: populationStats
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'El nombre de usuario ya existe.' });
        }
        // Manejo de errores específicos de coordenadas/facción (lanzados desde gameUtils)
        if (err.message && (err.message.includes('Facción') || err.message.includes('coordenada disponible'))) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: 'Error al registrar el asentamiento.', error: err.message });
    }
});

// Ruta para iniciar sesión
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // ⭐️ Seleccionamos faction_id
        const userResult = await pool.query(
            'SELECT id, username, password, wood, stone, food, current_population, last_resource_update, x_coord, y_coord, faction_id FROM users WHERE username = $1',
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
                current_population: currentPop,
                x_coord: parseInt(user.x_coord, 10), 
                y_coord: parseInt(user.y_coord, 10), 
                faction_id: parseInt(user.faction_id, 10), // ⭐️ Retornamos el ID de facción
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
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // ⭐️ Aseguramos que se seleccionan las coordenadas y el ID de facción
        const [userResult, buildingCountResult] = await Promise.all([
            pool.query(
                'SELECT id, username, wood, stone, food, current_population, last_resource_update, x_coord, y_coord, faction_id FROM users WHERE id = $1', 
                [userId]
            ),
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
                current_population: currentPop,
                x_coord: parseInt(user.x_coord, 10), // ⭐️ Incluimos X
                y_coord: parseInt(user.y_coord, 10), // ⭐️ Incluimos Y
                faction_id: parseInt(user.faction_id, 10), // ⭐️ Incluimos Faction ID
            },
            buildings: buildingsList,
            population: populationStats
        });

    } catch (err) {
        res.status(500).json({ message: 'Error al reanudar la sesión.', error: err.message });
    }
});

module.exports = router;

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

// -----------------------Ruta para registrar un nuevo usuario/asentamiento-------------------------
router.post('/register', async (req, res) => {
    const { username, password, factionId } = req.body; 

    // Validación de campos obligatorios
    if (!username || !password || !factionId) {
        return res.status(400).json({ message: 'Faltan campos: username, password y factionId son obligatorios.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        

        // 1️⃣ Insertar usuario
        const newUser = await pool.query(
            'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
            [username, hashedPassword]
        );

        const userId = newUser.rows[0].id;

        // 2️⃣ Asignar coordenadas aleatorias a la entidad del jugador
        const { x, y } = await findAvailableCoordinates(pool, factionId);



        // 3️⃣ Crear entidad del jugador
        const newEntity = await pool.query(
            `INSERT INTO entities 
            (user_id, type, faction_id, x_coord, y_coord, current_population, last_resource_update)
            VALUES ($1,'player',$2,$3,$4,$5,NOW())
            RETURNING id, x_coord, y_coord, current_population, last_resource_update, faction_id`,
            [userId, factionId, x, y, BASE_POPULATION]
        );


        // 4️⃣ Inicializar recursos del jugador
        const resourceTypes = await pool.query('SELECT id FROM resource_types');
        const entityId = newEntity.rows[0].id;

        for (const r of resourceTypes.rows) {
            await pool.query(
                'INSERT INTO entity_resources (entity_id, resource_type_id, amount) VALUES ($1, $2, 0)',
                [entityId, r.id]
            );
        }


        const token = createToken(userId, username);

        res.status(201).json({
            message: 'Registro exitoso.',
            user: { id: userId, username },
            entity: newEntity.rows[0],
            token,
            buildings: [],
            population: calculatePopulationStats([], BASE_POPULATION)
        });

    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Usuario ya existe.' });
        console.error(err);
        res.status(500).json({ message: 'Error al registrar usuario.', error: err.message });
    }
});


//---------------------------------------------------------------------------------------------------------------------------------//

// ----------------------------Ruta para iniciar sesión-------------------------------
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

 try {
        const userResult = await pool.query('SELECT id, username, password FROM users WHERE username=$1', [username]);
        const user = userResult.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password)))
            return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });

        // Obtener entidad del jugador
        const entityResult = await pool.query(
            'SELECT * FROM entities WHERE user_id=$1 AND type=$2',
            [user.id, 'player']
        );

        const entity = entityResult.rows[0];

        // Obtener recursos
        const resourcesResult = await pool.query(
            `SELECT rt.id, rt.name, er.amount
             FROM entity_resources er
             JOIN resource_types rt ON rt.id=er.resource_type_id
             WHERE er.entity_id=$1`,
            [entity.id]
        );

        const resources = {};
        for (const r of resourcesResult.rows) resources[r.name] = parseInt(r.amount, 10);

        const buildingCountResult = await pool.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE entity_id=$1 GROUP BY type',
            [entity.id]
        );

        const buildingsList = buildingCountResult.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));

        const populationStats = calculatePopulationStats(buildingsList, parseInt(entity.current_population, 10));

        const token = createToken(user.id, user.username);

        res.json({
            message: `Bienvenido, ${user.username}`,
            user: { id: user.id, username: user.username },
            entity,
            resources,
            buildings: buildingsList,
            population: populationStats,
            token
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error en login', error: err.message });
    }
});


// ------------------------------------------------------------------------------------------------------------------------------//

// ----------------------RUTA /api/me (Validar Sesión y Obtener Datos) ---------------------------
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const userResult = await pool.query('SELECT id, username FROM users WHERE id=$1', [userId]);
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const entityResult = await pool.query('SELECT * FROM entities WHERE user_id=$1 AND type=$2', [userId, 'player']);
        const entity = entityResult.rows[0];

        const resourcesResult = await pool.query(
            `SELECT rt.name, er.amount
             FROM entity_resources er
             JOIN resource_types rt ON rt.id=er.resource_type_id
             WHERE er.entity_id=$1`,
            [entity.id]
        );

        const resources = {};
        for (const r of resourcesResult.rows) resources[r.name] = parseInt(r.amount, 10);

        const buildingCountResult = await pool.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE entity_id=$1 GROUP BY type',
            [entity.id]
        );

        const buildingsList = buildingCountResult.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));

        const populationStats = calculatePopulationStats(buildingsList, parseInt(entity.current_population, 10));

        res.json({
            message: `Sesión reanudada para ${user.username}`,
            user,
            entity,
            resources,
            buildings: buildingsList,
            population: populationStats
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al validar sesión', error: err.message });
    }
});

module.exports = router;

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
            
        console.log(`Probando insertar recurso ${r.id} para la entidad ${entityId}`);
            await pool.query(
                'INSERT INTO resource_inventory (entity_id, resource_type_id, amount) VALUES ($1, $2, 0)',
                [entityId, r.id]
            );
        }

        console.log(`Nuevo usuario registrado: ${username} (ID: ${userId}) en las coordenadas (${x}, ${y})`);
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
             FROM resource_inventory er
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

 // 1️⃣ Buscar la entidad asociada al usuario
    const entityResult = await pool.query(
      `SELECT e.id, e.type, e.x_coord, e.y_coord, e.current_population, e.faction_id,
              f.name AS faction_name
       FROM entities e
       LEFT JOIN factions f ON f.id = e.faction_id
       WHERE e.user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (entityResult.rows.length === 0) {
      return res.status(404).json({ message: 'No se encontró ninguna entidad asociada a este usuario.' });
    }

    const entity = entityResult.rows[0];

    // 2️⃣ Obtener inventario de recursos
    const resourcesResult = await pool.query(
      `SELECT rt.id AS resource_type_id, rt.name, ri.amount
       FROM resource_inventory ri
       JOIN resource_types rt ON ri.resource_type_id = rt.id
       WHERE ri.entity_id = $1`,
      [entity.id]
    );

    const resources = {};
    for (const row of resourcesResult.rows) {
      resources[row.name.toLowerCase()] = parseInt(row.amount, 10);
      console.log(`Recurso: ${row.name}, cantidad: ${row.amount}`);
    }

    // 3️⃣ Obtener edificios asociados a la entidad (si existe tabla buildings)
    let buildings = [];
    try {
      const buildingsResult = await pool.query(
        `SELECT type AS type, COUNT(*) AS count
         FROM buildings
         WHERE entity_id = $1
         GROUP BY type`,
        [entity.id]
      );
      buildings = buildingsResult.rows.map(b => ({
        type: b.type,
        count: parseInt(b.count, 10),
      }));
    } catch (err) {
      console.warn('⚠️ Tabla buildings no encontrada o sin datos:', err.message);
    }

    // 4️⃣ Obtener info del usuario base
    const userResult = await pool.query(
      `SELECT id, username, created_at FROM users WHERE id = $1`,
      [userId]
    );

    const user = userResult.rows[0];

    // 5️⃣ Responder al frontend en formato amigable
   res.json({
  message: 'Datos de sesión cargados correctamente.',
  user: {
    id: user.id,
    username: user.username,
    created_at: user.created_at,
  },
  entity: {
    id: entity.id,
    faction_id: entity.faction_id,
    faction_name: entity.faction_name,
    x_coord: entity.x_coord,
    y_coord: entity.y_coord,
    resources,  // aquí sí incluyes los recursos
    current_population: entity.current_population || 0,
    max_population: entity.max_population || 0, // o calcula según edificios
  },
  buildings,
  population: {
    current_population: entity.current_population || 0,
    max_population: entity.max_population || 0,
    available_population: (entity.max_population || 0) - (entity.current_population || 0),
  },
});

  } catch (error) {
    console.error('Error en /me:', error);
    res.status(500).json({ message: 'Error al obtener los datos del usuario', error: error.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcrypt'); 
const { calculatePopulationStats, findAvailableCoordinates } = require('../utils/gameUtils');
// ⭐️ Importación centralizada:
const { authenticateToken } = require('../middleware/auth'); 
const { getResources } = require('../utils/resourcesService');
const { getBuildings } = require('../utils/buildingsService');

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

const { BUILDING_COSTS } = require('../constants/buildings');

//funcion para calcular el coste de un edificio en funcion de su nivel
function calculateNextLevelCost(building) {
  const costDef = BUILDING_COSTS[building.type];
  if (!costDef) return { wood: 0, stone: 0, food: 0 };

  // Aplicamos el multiplicador por nivel (ejemplo: 1.5 por cada nivel)
  const multiplier = 1.5;
  const level = building.level || 0;

  return {
    wood: Math.ceil(costDef.wood * Math.pow(multiplier, level)),
    stone: Math.ceil(costDef.stone * Math.pow(multiplier, level)),
    food: Math.ceil(costDef.food * Math.pow(multiplier, level)),
  };
}


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



        // 3️⃣ Crear entidad del jugador y inicializar recursos usando helper
        const { createEntityWithResources } = require('../utils/entityService');
        const resourceTypes = await pool.query('SELECT id, name FROM resource_types');
        const defaults = {};
        for (const r of resourceTypes.rows) {
          const name = (r.name || '').toLowerCase();
          defaults[name] = (new Set(['wood','stone','water','food']).has(name)) ? 100 : 0;
        }
        const newEntity = await createEntityWithResources(pool, {
          user_id: userId,
          faction_id: factionId,
          type: 'player',
          x_coord: x,
          y_coord: y,
          population: BASE_POPULATION,
          initialResources: defaults
        });

    // 5️⃣ Crear ciudades IA para las demás facciones
    try {
      const factionsRes = await pool.query('SELECT id, name FROM factions WHERE id <> $1', [factionId]);
      const aiCityService = require('../utils/ai_city_service');
      for (const f of factionsRes.rows) {
        // Find available coordinates for this faction
        const { x: ax, y: ay } = await findAvailableCoordinates(pool, f.id);
        // Create paired AI city with defaults (service will set population=100 and resources=1000)
        await aiCityService.createPairedCity(pool, {
          name: `IA ${f.name}`,
          faction_id: f.id,
          type: 'cityIA',
          x_coord: ax,
          y_coord: ay
        });
      }
    } catch (aiErr) {
      console.warn('Error creando ciudades IA al registrar usuario:', aiErr.message);
    }

        console.log(`Nuevo usuario registrado: ${username} (ID: ${userId}) en las coordenadas (${x}, ${y})`);
        const token = createToken(userId, username);

    res.status(201).json({
      message: 'Registro exitoso.',
      user: { id: userId, username },
      entity: newEntity,
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

    // Obtener recursos (servicio centralizado)
    const resources = await getResources(entity.id);

    const buildingsList = await getBuildings(entity.id);

  const populationService = require('../utils/populationService');
  const popSummary = await populationService.getPopulationSummary(entity.id);
  const populationStats = calculatePopulationStats(buildingsList, parseInt(popSummary.total || 0, 10));

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
      `SELECT e.id, e.type, e.x_coord, e.y_coord, e.faction_id,
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

    // 2️⃣ Obtener inventario de recursos (servicio centralizado)
    const resources = await getResources(entity.id);

    // 3️⃣ Obtener edificios asociados a la entidad (si existe tabla buildings)
    let buildings = [];
    try {
      buildings = await getBuildings(entity.id);
      buildings = buildings.map(b => ({
        type: b.type,
        level: b.level,
        count: b.count,
        nextLevelCost: calculateNextLevelCost({ type: b.type, level: b.level })
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
  // population comes from the populations table
  current_population: popSummary.total || 0,
  max_population: popSummary.max || 0, // o calcula según edificios
  },
  buildings,
  population: {
  current_population: popSummary.total || 0,
  max_population: popSummary.max || 0,
  available_population: popSummary.available || 0,
  },
});

  } catch (error) {
    console.error('Error en /me:', error);
    res.status(500).json({ message: 'Error al obtener los datos del usuario', error: error.message });
  }
});

module.exports = router;

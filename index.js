require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors'); 
const jwt = require('jsonwebtoken'); 
const JWT_SECRET = process.env.JWT_SECRET; 
const bcrypt = require('bcrypt'); 

const app = express();
app.use(express.json());
app.use(cors());

// Conexión a la base de datos de Neon
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
        { expiresIn: '7d' } 
    );
};

// Middleware para verificar el token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401); 

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); 
        req.user = user; 
        next();
    });
};

// -----------------------------------------------------------------
// ⭐️ CONFIGURACIÓN DE POBLACIÓN Y PRODUCCIÓN
// -----------------------------------------------------------------

// Lógica de Población
const BASE_POPULATION = 10;
const POPULATION_PER_HOUSE = 5;
// Cantidad de comida consumida por 1 ciudadano por intervalo de 10s
const FOOD_CONSUMPTION_PER_CITIZEN = 1; 
// Tasa de cambio de población por ciclo de producción
const POPULATION_CHANGE_RATE = 1; 

// Tasa de producción por edificio (por intervalo de 10 segundos)
const PRODUCTION_RATES = {
    // La casa solo aumenta la población máxima, no produce recursos base
    'house': { food: 0, wood: 0, stone: 0 }, 
    'sawmill': { wood: 5, stone: 0, food: -1 }, // Consume comida
    'quarry': { stone: 8, wood: 0, food: -2 }, // Consume comida
    'farm': { food: 10, wood: -1, stone: 0 } // Produce comida, consume un poco de madera
};

// Definir costes de construcción
const BUILDING_COSTS = {
    'house': { wood: 20, stone: 10, food: 5 },
    'sawmill': { wood: 50, stone: 30, food: 10 }, 
    'quarry': { wood: 40, stone: 80, food: 15 },
    'farm': { wood: 40, stone: 10, food: 10 }
};

// Función auxiliar para calcular las estadísticas de población
const calculatePopulationStats = (userBuildings, currentPopFromDB) => {
    let maxPopulation = BASE_POPULATION; 
    
    userBuildings.forEach(building => {
        if (building.type === 'house') {
            maxPopulation += building.count * POPULATION_PER_HOUSE;
        }
    });

    // La población actual es dinámica y no puede superar el máximo.
    const currentPopulation = Math.min(currentPopFromDB, maxPopulation);

    return {
        max_population: maxPopulation,
        current_population: currentPopulation 
    };
};

// Función auxiliar para calcular la producción total, incluyendo el consumo de la población
const calculateProduction = (userBuildings, populationStats) => {
    let production = { wood: 0, stone: 0, food: 0 };
    
    if (!Array.isArray(userBuildings)) {
        return production;
    }

    // 1. Calcular producción/consumo fijo de edificios 
    userBuildings.forEach(building => {
        const rate = PRODUCTION_RATES[building.type];
        if (rate && building.count > 0) {
            production.wood += (rate.wood || 0) * building.count;
            production.stone += (rate.stone || 0) * building.count;
            production.food += (rate.food || 0) * building.count;
        }
    });
    
    // 2. Calcular Consumo de Comida basado en la Población actual
    const foodConsumption = populationStats.current_population * -FOOD_CONSUMPTION_PER_CITIZEN;
    production.food += foodConsumption;
    
    return production;
};

// -----------------------------------------------------------------
// --- RUTAS DE AUTENTICACIÓN (Registro, Login) ---
// -----------------------------------------------------------------

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
  const saltRounds = 10;
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // ⭐️ FIX: Incluir current_population en la inserción y retorno
    const newUser = await pool.query(
      'INSERT INTO users (username, password, current_population) VALUES ($1, $2, $3) RETURNING id, username, wood, stone, food, current_population',
      [username, hashedPassword, BASE_POPULATION]
    );
    
    const token = createToken(newUser.rows[0].id, newUser.rows[0].username); 
    
    const buildingsList = []; 
    // Usar la población inicial para las estadísticas
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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // ⭐️ FIX: Incluir current_population en la selección
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
      token: token,
      buildings: buildingsList,
      population: populationStats
    });

  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión.', error: err.message });
  }
});

// --- RUTA /api/me (Validar Sesión y Obtener Datos) ---
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const [userResult, buildingCountResult] = await Promise.all([
            // ⭐️ FIX: Incluir current_population en la selección
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

// RUTA CONSTRUCCION
app.post('/api/build', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { buildingType } = req.body; 

    const cost = BUILDING_COSTS[buildingType];
    if (!cost) {
        return res.status(400).json({ message: 'Tipo de edificio no válido.' });
    }

    const client = await pool.connect(); 

    try {
        await client.query('BEGIN'); 

        // 2. Obtener los recursos y población actuales del usuario
        const currentResources = await client.query(
            // ⭐️ FIX: Incluir current_population en la selección
            'SELECT wood, stone, food, current_population FROM users WHERE id = $1 FOR UPDATE', 
            [userId]
        );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        // ⭐️ Obtener datos del usuario incluyendo la población
        const user = {
            wood: parseInt(currentResources.rows[0].wood, 10),
            stone: parseInt(currentResources.rows[0].stone, 10),
            food: parseInt(currentResources.rows[0].food, 10),
            current_population: parseInt(currentResources.rows[0].current_population, 10), 
        };

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
             RETURNING wood, stone, food, username, current_population`, // ⭐️ FIX: Retornar current_population
            [cost.wood, cost.stone, cost.food, userId]
        );

        const updatedUser = updatedResources.rows[0]; // ⭐️ FIX: Usar 'updatedUser'

        // 5. Registrar el nuevo edificio
        await client.query(
            'INSERT INTO buildings (user_id, type) VALUES ($1, $2)',
            [userId, buildingType]
        );

        await client.query('COMMIT'); 

        // 6. Obtener la lista de edificios y calcular población
        const buildingCountResult = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type',
            [userId]
        );

        const buildingsList = buildingCountResult.rows.map(row => ({
            type: row.type,
            count: parseInt(row.count, 10)
        }));
        
        // La población actual es la que no fue modificada por la construcción
        const populationStats = calculatePopulationStats(buildingsList, user.current_population);

        res.status(200).json({
            message: `¡Construido con éxito! Has añadido 1 ${buildingType}.`,
            user: {
                username: updatedUser.username,
                wood: parseInt(updatedUser.wood, 10),
                stone: parseInt(updatedUser.stone, 10),
                food: parseInt(updatedUser.food, 10),
                current_population: parseInt(updatedUser.current_population, 10), // ⭐️ FIX: Usar updatedUser
            },
            buildings: buildingsList,
            population: populationStats
        });

    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error('Error en la construcción:', err.message);
        res.status(500).json({ message: 'Error en la construcción.', error: err.message });
    } finally {
        client.release();
    }
});


// -----------------------------------------------------------------
// RUTA: Generación periódica de recursos (/api/generate-resources)
// -----------------------------------------------------------------
app.post('/api/generate-resources', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const client = await pool.connect(); 

    try {
        await client.query('BEGIN'); 

        // 1. Obtener edificios
        const buildingCountResult = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type', 
            [userId]
        );
        
        const buildingsList = buildingCountResult.rows.map(row => ({
            type: row.type,
            count: parseInt(row.count, 10)
        }));
        
        // 2. Obtener los recursos y población actuales del usuario (y bloquear la fila)
        const currentResources = await client.query(
            // ⭐️ FIX: Aseguramos current_population en la selección
            'SELECT wood, stone, food, current_population FROM users WHERE id = $1 FOR UPDATE', 
            [userId]
        );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        
        // ⭐️ FIX: Convertir explícitamente a enteros y usar variable 'user'
        const user = {
            wood: parseInt(currentResources.rows[0].wood, 10),
            stone: parseInt(currentResources.rows[0].stone, 10),
            food: parseInt(currentResources.rows[0].food, 10),
            current_population: parseInt(currentResources.rows[0].current_population, 10), 
        };

        // 3. Calcular estadísticas de población y producción
        const populationStats = calculatePopulationStats(buildingsList, user.current_population);
        const production = calculateProduction(buildingsList, populationStats);
        
        // ---------------------------------------------
        // ⭐️ LÓGICA DE POBLACIÓN DINÁMICA
        // ---------------------------------------------
        let newPopulation = populationStats.current_population;
        const maxPopulation = populationStats.max_population;
        const netFoodProduction = production.food;

        if (netFoodProduction >= 0) {
            // Superávit de comida: la población crece (hasta el máximo)
            newPopulation = Math.min(maxPopulation, newPopulation + POPULATION_CHANGE_RATE);
        } else {
            // Déficit de comida: la población decrece (mínimo 1)
            newPopulation = Math.max(1, newPopulation - POPULATION_CHANGE_RATE);
        }
        
        // 4. Aplicar producción (usando las variables del objeto 'user')
        const newWood = user.wood + production.wood;
        const newStone = user.stone + production.stone;
        // Si la producción de comida es negativa (consumo), aseguramos que el recurso no baje de 0
        const newFood = Math.max(0, user.food + netFoodProduction); 

        // 5. Actualizar la base de datos (incluyendo la nueva población)
        const updatedResources = await client.query(
            `UPDATE users SET
                wood = $1,
                stone = $2,
                food = $3,
                current_population = $5
             WHERE id = $4
             RETURNING wood, stone, food, username, current_population`, // ⭐️ FIX: Incluir current_population
            [newWood, newStone, newFood, userId, newPopulation] // ⭐️ FIX: newPopulation se pasa como $5
        );

        await client.query('COMMIT'); 

        const updatedUser = updatedResources.rows[0]; // ⭐️ FIX: Usar updatedUser

        // 6. Recalcular las estadísticas con la nueva población guardada para la respuesta
        const finalPopulationStats = calculatePopulationStats(buildingsList, parseInt(updatedUser.current_population, 10));

        // 7. Responder al cliente
        res.status(200).json({
            message: `Generación: Madera: ${production.wood >= 0 ? '+' : ''}${production.wood}, Piedra: ${production.stone >= 0 ? '+' : ''}${production.stone}, Comida: ${production.food >= 0 ? '+' : ''}${production.food}. Población: ${populationStats.current_population} -> ${finalPopulationStats.current_population}.`,
            user: {
                username: updatedUser.username,
                wood: parseInt(updatedUser.wood, 10),
                stone: parseInt(updatedUser.stone, 10),
                food: parseInt(updatedUser.food, 10),
                current_population: finalPopulationStats.current_population,
            },
            buildings: buildingsList,
            population: finalPopulationStats
        });


    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en generate-resources:', err.message);
        res.status(500).json({ message: 'Error en la generación de recursos.', error: err.message });
    } finally {
        client.release();
    }
});


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});
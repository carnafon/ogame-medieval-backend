require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors'); // Necesario para que el frontend pueda comunicarse con el backend
const jwt = require('jsonwebtoken'); 
const JWT_SECRET = process.env.JWT_SECRET; // Obtiene el secreto del .env
const bcrypt = require('bcrypt'); // Para hashear contraseñas 

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

// -----------------------------------------------------------------
// ⭐️ NUEVO: CONFIGURACIÓN DE PRODUCCIÓN Y COSTES Y POBLACION
// -----------------------------------------------------------------


// Lógica de Población
const BASE_POPULATION = 10;
const POPULATION_PER_HOUSE = 5;
// Cantidad de comida consumida por 1 ciudadano por intervalo de 10s
const FOOD_CONSUMPTION_PER_CITIZEN = 1
// Tasa de cambio de población por ciclo de producción
const POPULATION_CHANGE_RATE = 1; 

// Tasa de producción por edificio (por intervalo de 10 segundos)
const PRODUCTION_RATES = {
    'house': { food: 1, wood: 0, stone: 0 }, 
    'sawmill': { wood: 5, stone: 0, food: -1 },
    'quarry':{stone:8, wood:0, food:-2}, 
    'farm': { food: 10, wood: -1, stone: 0 } // Ejemplo de granja que produce comida
};

// Definir costes de construcción
const BUILDING_COSTS = {
    'house': { wood: 20, stone: 10, food: 5 },
    'sawmill': { wood: 50, stone: 30, food: 10 }, // Nuevo coste del Aserradero
    'quarry': { wood: 40, stone: 80, food: 15 }, // Nuevo coste de la Cantera
    'farm': { wood: 40, stone: 10, food: 0 } // Nuevo coste de la Granja
};

// Función auxiliar para calcular las estadísticas de población
const calculatePopulationStats = (userBuildings,currentPopFromDB) => {
    let maxPopulation = BASE_POPULATION; // Población base
    
    
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
const calculateProduction = (userBuildings,populationStats) => {
    let production = { wood: 0, stone: 0, food: 0 };
    
    // userBuildings debe ser un array (ej: [{type: 'house', count: 2}])
    if (!Array.isArray(userBuildings)) {
        return production;
    }
   // 1. Calcular producción/consumo fijo de edificios (Sawmill, Quarry)
    userBuildings.forEach(building => {
        const rate = PRODUCTION_RATES[building.type];
        if (rate && building.count > 0) {
            production.wood += (rate.wood || 0) * building.count;
            production.stone += (rate.stone || 0) * building.count;
            production.food += (rate.food || 0) * building.count;
        }
    });

 // 2. Calcular Consumo de Comida basado en la Población
    // La población actual consume comida.
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
  // 1. Cifrar (Hash) la contraseña
  const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // NOTA: Asegúrate de que tu tabla 'users' tenga las columnas 'wood', 'stone', 'food', 'current poblation con valores por defecto.
  const newUser = await pool.query(
   'INSERT INTO users (username, password,current_population) VALUES ($1, $2, $3) RETURNING id, username, wood, stone, food',
    [username, hashedPassword,BASE_POPULATION]
  );
    
  const token = createToken(newUser.rows[0].id, newUser.rows[0].username); // Genera el token

  const buildingsList = []; 
    // Usar la población inicial para las estadísticas
    const populationStats = calculatePopulationStats(buildingsList, BASE_POPULATION);

  res.status(201).json({
   message: 'Usuario registrado con éxito.',
   user:{ ...newUser.rows[0],
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

  // 3. Verificar la contraseña
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

    // ⭐️ Pasar la población actual del usuario a las estadísticas
    const currentPop = parseInt(user.current_population, 10);
    const populationStats = calculatePopulationStats(buildingsList, currentPop);


  // 4. Login exitoso: devolver los datos del usuario y recursos
  const token = createToken(user.id, user.username); // Genera el token

  res.status(200).json({
   message: `¡Bienvenido de nuevo, ${user.username}!`,
   user: {
    id:user.id,
    username: user.username,
    wood: parseInt(user.wood, 10),
    stone: parseInt(user.stone, 10), 
    food: parseInt(user.food, 10),
    current_population: currentPop
   },
   buildings: buildingsList,
   population: populationStats, // <-- Enviamos las estadísticas de población
   token: token 
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
            // ⭐️ Incluir current_population en la selección
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

     // Calcular estadísticas de población
    const currentPop = parseInt(user.current_population, 10);   
    const populationStats = calculatePopulationStats(buildingsList, currentPop);

    // Devuelve los datos del usuario y sus edificios
    res.status(200).json({
     message: `Sesión reanudada para ${user.username}.`,
     user: {
                id: user.id,
                username: user.username,
                // ⭐️ Importante: Convertir recursos a INT al enviarlos al frontend
                wood: parseInt(user.wood, 10), 
                stone: parseInt(user.stone, 10), 
                food: parseInt(user.food, 10),
                current_population: currentPop // ⭐️ Incluir la población actual
            },
            buildings: buildingsList,
            population: populationStats
    });

  } catch (err) {
    res.status(500).json({ message: 'Error al reanudar la sesión.', error: err.message });
  }
});

//RUTA CONSTRUCCION
app.post('/api/build', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { buildingType } = req.body; 
  // 1. Verificar si el tipo de edificio es válido
  const cost = BUILDING_COSTS[buildingType];

  console.log("Tipo de edificio solicitado:", buildingType);
  if (!cost) {
    return res.status(400).json({ message: 'Tipo de edificio no válido.' });
  }

  const client = await pool.connect(); 

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

   

   // ⭐️ FIX: Convertir explícitamente a enteros antes de comparar
   const user = {
            wood: parseInt(currentResources.rows[0].wood, 10),
            stone: parseInt(currentResources.rows[0].stone, 10),
            food: parseInt(currentResources.rows[0].food, 10),
            current_population: parseInt(currentResources.rows[0].current_population, 10), // ⭐️ Obtener población
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

    const populationStats = calculatePopulationStats(buildingsList, user.current_population);

    res.status(200).json({
      message: `¡Construido con éxito! Has añadido 1 ${buildingType}.`,
     user: {
                username: updatedUserRaw.username,
                wood: parseInt(updatedUserRaw.wood, 10),
                stone: parseInt(updatedUserRaw.stone, 10),
                food: parseInt(updatedUserRaw.food, 10),
                current_population: parseInt(updatedUserRaw.current_population, 10), // ⭐️ Incluir población actual
            },
      buildings: buildingsList,
            population: populationStats
    });

  } catch (err) {
    await client.query('ROLLBACK'); // Deshacer si hay error
   res.status(500).json({ message: 'Error en la construcción.', error: err.message });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------------
// ⭐️ NUEVA RUTA: Generación periódica de recursos (/api/generate-resources)
// -----------------------------------------------------------------
app.post('/api/generate-resources', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const client = await pool.connect(); 

    try {
        await client.query('BEGIN'); // Iniciar la transacción para asegurar datos consistentes

        // 1. Obtener la lista de edificios y contarlos
        const buildingCountResult = await client.query(
            'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type', 
            [userId]
        );
        
        const buildingsList = buildingCountResult.rows.map(row => ({
            type: row.type,
            count: parseInt(row.count, 10)
        }));
        


        // 2. Calcular la poblacion total
        const populationStats = calculatePopulationStats(buildingsList); 

        // 3. Calcular la producción total (incluyendo consumo de población)
        const production = calculateProduction(buildingsList,populationStats);
        
        // 4. Obtener los recursos actuales del usuario (y bloquear la fila)
        const currentResources = await client.query(
      'SELECT wood, stone, food, current_population FROM users WHERE id = $1 FOR UPDATE', 
      [userId]
    );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        
        const user = currentResources.rows[0];

        // ⭐️ FIX: Asegurar que los recursos sean números enteros antes del cálculo
        const currentWood = parseInt(user.wood, 10);
        const currentStone = parseInt(user.stone, 10);
        const currentFood = parseInt(user.food, 10);
        const currentPopulation = parseInt(user.current_population, 10);

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



        // 5. Aplicar producción y asegurar que la comida no sea negativa
        const newWood = currentWood + production.wood;
        const newStone = currentStone + production.stone;
        // La comida puede ser consumida (producción negativa), por eso Math.max(0, ...)
        const newFood = Math.max(0, currentFood + production.food); 

        // 6. Actualizar la base de datos
        const updatedResources = await client.query(
            `UPDATE users SET
                wood = $1,
                stone = $2,
                food = $3
             WHERE id = $4
             RETURNING wood, stone, food, username`,
            [newWood, newStone, newFood, userId, newPopulation]
        );

        await client.query('COMMIT'); // Confirmar la transacción

        const updatedUser = updatedResources.rows[0];

        // 7. Responder al cliente
        res.status(200).json({
            message: `Generación: Madera: ${production.wood >= 0 ? '+' : ''}${production.wood}, Piedra: ${production.stone >= 0 ? '+' : ''}${production.stone}, Comida: ${production.food >= 0 ? '+' : ''}${production.food}`,
             user: {
                username: updatedUserRaw.username,
                wood: parseInt(updatedUserRaw.wood, 10),
                stone: parseInt(updatedUserRaw.stone, 10),
                food: parseInt(updatedUserRaw.food, 10),
                current_population: finalPopulationStats.current_population, // ⭐️ La población final
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


// -----------------------------------------------------------------
// Lógica de generación pasiva de recursos (setInterval)
// -----------------------------------------------------------------
// Lógica de generación pasiva de recursos (se ejecuta cada minuto)

setInterval(async () => {

 try {

  const resourceGrowthWood = 3; // 1 unidad por minuto para empezar
  const resourceGrowthStone = 1;
  const resourceGrowthFood = 2;

  await pool.query(

   `UPDATE users SET

    wood = wood + ${resourceGrowthWood},

    stone = stone + ${resourceGrowthStone},

    food = food + ${resourceGrowthFood}`

  );

 } catch (err) {

  console.error('Error al actualizar recursos:', err.message);

 }

}, 60000); // 60,000 milisegundos = 1 minuto



const port = process.env.PORT || 3000;
app.listen(port, () => {
 console.log(`Servidor escuchando en el puerto ${port}`);
}); 

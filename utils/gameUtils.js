// -----------------------------------------------------------------
// ⭐️ CONSTANTES DE POBLACIÓN Y PRODUCCIÓN
// -----------------------------------------------------------------
const BASE_POPULATION = 10;
const POPULATION_PER_HOUSE = 5;
const FOOD_CONSUMPTION_PER_CITIZEN = 1;

// --- CONSTANTES DEL MAPA Y COORDENADAS ---
const MAP_SIZE = 100; // Tamaño máximo del mapa (100x100)
const COORD_RADIUS = 25; // Radio de la zona de influencia de la facción (ej: 25 unidades alrededor del spawn central)
// ------------------------------------------


// Tasa de producción por edificio (por intervalo de 10 segundos)
const PRODUCTION_RATES = {
    'house': { food: 0, wood: 0, stone: 0 }, 
    'sawmill': { wood: 5, stone: 0, food: -1 },
    'quarry':{stone:8, wood:0, food:-2}, 
    'farm': { food: 10, wood: -1, stone: 0 } 
};

// Longitud de un "tick" en segundos (coincide con las tasas anteriores)
const TICK_SECONDS = 10;

// Configuración del generador de recursos (valores por defecto centralizados aquí)
const RESOURCE_GENERATOR_INTERVAL_SECONDS = 10; // intervalo de ejecución del job
const RESOURCE_GENERATOR_WOOD_PER_TICK = 2; // suma fija de madera por tick
const RESOURCE_GENERATOR_STONE_PER_TICK = 1; // suma fija de piedra por tick


// -----------------------------------------------------------------
// ⭐️ FUNCIONES AUXILIARES
// -----------------------------------------------------------------


/**
 * Busca coordenadas desocupadas para el asentamiento dentro de la zona de influencia de una facción.
 * El asentamiento se colocará en un radio de COORD_RADIUS alrededor del punto de spawn central de la facción.
 * * @param {object} pool Conexión a la base de datos (pg Pool).
 * @param {number} factionId ID de la facción elegida por el usuario.
 * @returns {Promise<{x: number, y: number}>} Coordenadas x e y disponibles.
 */
const findAvailableCoordinates = async (pool, factionId) => {
    if (!factionId) {
        throw new Error("Se requiere un factionId para determinar la zona de influencia.");
    }

    // 1. Obtener el punto central de spawn de la facción
    const factionRes = await pool.query(
        'SELECT spawn_x, spawn_y FROM factions WHERE id = $1',
        [factionId]
    );

    if (factionRes.rows.length === 0) {
        throw new Error(`Facción con ID ${factionId} no encontrada.`);
    }
    
    // NOTA: Asumimos que la tabla 'factions' tiene 'spawn_x' y 'spawn_y'
    const { spawn_x, spawn_y } = factionRes.rows[0]; 
    
    let x, y, isOccupied;
    let attempts = 0;
    const MAX_ATTEMPTS = 50;
    
    // Bucle para buscar una coordenada desocupada dentro del radio
    while (isOccupied || attempts === 0) {
        if (attempts >= MAX_ATTEMPTS) {
            // Si fallamos, retornamos la coordenada central como último recurso, asumiendo un riesgo de colisión
            console.warn(`No se encontró coordenada disponible en el radio de influencia después de ${MAX_ATTEMPTS} intentos. Cayendo a las coordenadas centrales.`);
            return { x: spawn_x, y: spawn_y }; 
        }

        // Generar desplazamiento aleatorio (-COORD_RADIUS a +COORD_RADIUS)
        const randX = Math.floor(Math.random() * (2 * COORD_RADIUS + 1)) - COORD_RADIUS;
        const randY = Math.floor(Math.random() * (2 * COORD_RADIUS + 1)) - COORD_RADIUS;

        // Calcular la posición final
        const newX = spawn_x + randX;
        const newY = spawn_y + randY;
        
        // Asegurar que las coordenadas estén dentro de los límites del mapa (0 a MAP_SIZE-1)
        x = Math.min(MAP_SIZE - 1, Math.max(0, newX));
        y = Math.min(MAP_SIZE - 1, Math.max(0, newY));

        attempts++;

        // Consultar si algún otro usuario ya tiene estas coordenadas
        const checkRes = await pool.query(
            'SELECT id FROM entities WHERE x_coord = $1 AND y_coord = $2',
            [x, y]
        );

        isOccupied = checkRes.rows.length > 0;
    } 

    return { x, y };
};

/**
 * Calcula la población máxima y la población actual ajustada.
 * @param {Array<{type: string, count: number}>} userBuildings Lista de edificios del usuario.
 * @param {number} currentPopFromDB Población actual del usuario en la DB.
 * @returns {{max_population: number, current_population: number}}
 */
const calculatePopulationStats = (userBuildings, currentPopFromDB) => {
    let maxPopulation = BASE_POPULATION; 
    
    userBuildings.forEach(building => {
        if (building.type === 'house') {
            maxPopulation += building.count * POPULATION_PER_HOUSE;
        }
    });
 
    // La población actual no puede superar el máximo.
    const currentPopulation = Math.min(currentPopFromDB, maxPopulation);

    return {
        max_population: maxPopulation,
        current_population: currentPopulation 
    };
};

/**
 * Calcula la producción neta de recursos (producción de edificios - consumo de población).
 * @param {Array<{type: string, count: number}>} userBuildings Lista de edificios del usuario.
 * @param {{current_population: number}} populationStats Estadísticas de población.
 * @returns {{wood: number, stone: number, food: number}}
 */
const calculateProduction = (userBuildings, populationStats) => {
    let production = { wood: 0, stone: 0, food: 0 };
    
    if (!Array.isArray(userBuildings)) {
        return production;
    }

    // 1. Calcular producción/consumo fijo de edificios
    // Ahora usamos `building.level` como medida para la contribución del edificio.
    // Si `level` no está presente, hacemos fallback a `count` para compatibilidad con datos antiguos.
    userBuildings.forEach(building => {
        const rate = PRODUCTION_RATES[building.type];
        if (!rate) return;

        // Preferir `level` si existe, si no usar `count`, si no 0.
        const qty = (typeof building.level === 'number')
            ? building.level
            : (typeof building.count === 'number' ? building.count : 0);

        if (qty <= 0) return;

        production.wood += (rate.wood || 0) * qty;
        production.stone += (rate.stone || 0) * qty;
        production.food += (rate.food || 0) * qty;
    });
    
    // 2. Calcular Consumo de Comida basado en la Población actual
    const foodConsumption = populationStats.current_population * -FOOD_CONSUMPTION_PER_CITIZEN;
    production.food += foodConsumption;
    

    return production;
};

/**
 * Calcula la producción acumulada durante una duración en segundos.
 * Escala la producción definida en PRODUCTION_RATES (por tick de TICK_SECONDS).
 * Devuelve números enteros: floor para positivos, ceil para negativos.
 *
 * @param {Array<{type:string,count:number}>} userBuildings
 * @param {{current_population:number}} populationStats
 * @param {number} seconds
 * @returns {{wood:number,stone:number,food:number}}
 */
const calculateProductionForDuration = (userBuildings, populationStats, seconds) => {
    if (seconds <= 0) return { wood: 0, stone: 0, food: 0 };

    // Producción por tick (la función calculateProduction devuelve producción por tick)
    const perTick = calculateProduction(userBuildings, populationStats);
    const multiplier = seconds / TICK_SECONDS;

    const scaled = {
        wood: perTick.wood * multiplier,
        stone: perTick.stone * multiplier,
        food: perTick.food * multiplier
    };

    const final = { wood: 0, stone: 0, food: 0 };
    Object.keys(final).forEach(k => {
        const v = scaled[k];
        final[k] = v >= 0 ? Math.floor(v) : Math.ceil(v);
    });

    return final;
};

module.exports = {
    calculatePopulationStats,
    calculateProduction,
    calculateProductionForDuration,
    // Constantes exportadas
    TICK_SECONDS,
    RESOURCE_GENERATOR_INTERVAL_SECONDS,
    RESOURCE_GENERATOR_WOOD_PER_TICK,
    RESOURCE_GENERATOR_STONE_PER_TICK,
    MAP_SIZE,
    COORD_RADIUS, // Exportamos el radio de influencia
    findAvailableCoordinates
};

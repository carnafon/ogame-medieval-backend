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
// Cada entrada describe la producción neta por tick para recursos según claves en la DB (ej: wood, stone, food, water, clay, leather, coal, copper, wool, honey)
const PRODUCTION_RATES = {
    'house': { },
    'sawmill': { wood: 5, food: 0 },
    'quarry': { stone: 8, food: 0 },
    'farm': { food: 10, wood: -1 },
    // Nuevos edificios para recursos comunes
    'well': { water: 5 },
    'clay_pit': { clay: 4 },
    'tannery': { leather: 3 },
    'coal_mine': { coal: 3 },
    'copper_mine': { copper: 3 },
    'sheepfold': { wool: 2, food: 0 },
    'apiary': { honey: 1 }
};

// Procesados adicionales: cada edificio produce 1 unidad por tick (10s) de su producto
PRODUCTION_RATES['carpinteria'] = { lumber: 1 }; // produces processed wood
PRODUCTION_RATES['fabrica_ladrillos'] = { baked_brick: 1 };
PRODUCTION_RATES['bazar_especias'] = { spice: 1 };
PRODUCTION_RATES['alfareria'] = { refined_clay: 1 };
PRODUCTION_RATES['tintoreria_morada'] = { purple_dye: 1 };
PRODUCTION_RATES['herreria'] = { iron_ingot: 1 };
PRODUCTION_RATES['salazoneria'] = { salted: 1 };
PRODUCTION_RATES['libreria'] = { books: 1 };
PRODUCTION_RATES['cerveceria'] = { beer: 1 };
PRODUCTION_RATES['forja'] = { tools: 1 };

// Specialized buildings (produce 1 unit per tick)
PRODUCTION_RATES['elixireria'] = { preservation_elixir: 1 };
PRODUCTION_RATES['tintoreria_real'] = { royal_dye: 1 };
PRODUCTION_RATES['escriba'] = { illustrated_parchment: 1 };
PRODUCTION_RATES['artificiero'] = { explosive_compound: 1 };
PRODUCTION_RATES['herreria_real'] = { damascus_steel: 1 };
PRODUCTION_RATES['lineria'] = { linen: 1 };

// Strategic building production (produce fragile/processed items per tick)
PRODUCTION_RATES['tintoreria_dorada'] = { golden_dye: 1 };
PRODUCTION_RATES['herreria_mitica'] = { rare_iron: 1 };
PRODUCTION_RATES['salinas'] = { sea_salt: 1 };
PRODUCTION_RATES['mina_azufre'] = { sulfur: 1 };
PRODUCTION_RATES['mina_gemas'] = { gems: 1 };
PRODUCTION_RATES['telar_real'] = { royal_silk: 1 };

// Añadimos la Sastrería como edificio procesador que produce silk_cloth
PRODUCTION_RATES['sastreria'] = { silk_cloth: 1 };

// Procesamiento: productos que requieren insumos por unidad producida.
// Mapeo: producto -> { inputResource: amountPerUnit, ... }
const PROCESSING_RECIPES = {
    // La Sastrería produce silk_cloth consumiendo 10 wool, 2 wood y 1 purple_dye por unidad
    silk_cloth: { wool: 10, wood: 2, purple_dye: 1 }
    // Otros procesos añadidos
    , lumber: { wood: 5, stone: 1 }
    , baked_brick: { clay: 8, coal: 2 }
    , spice: { food: 5, honey: 2 }
    , refined_clay: { clay: 6, water: 3 }
    , purple_dye: { wool: 6, copper: 1 }
    , iron_ingot: { copper: 4, coal: 3 }
    , salted: { leather: 3, stone: 1 }
    , books: { wool: 2, wood: 4 }
    , beer: { food: 6, water: 4 }
    , tools: { copper: 3, wood: 2 }
    , preservation_elixir: { honey: 4, spice: 3 }
    , royal_dye: { copper: 2, purple_dye: 2 }
    , illustrated_parchment: { water: 2, books: 3 }
    , explosive_compound: { coal: 5, baked_brick: 2 }
    , damascus_steel: { stone: 6, iron_ingot: 2 }
    , linen: { leather: 4, silk_cloth: 2 }
        // Strategic processing recipes
        , golden_dye: { wool: 5, silk_cloth: 2, royal_dye: 1 }
        , rare_iron: { stone: 10, iron_ingot: 2, damascus_steel: 1 }
        , sea_salt: { food: 8, beer: 2, preservation_elixir: 1 }
        , sulfur: { coal: 6, explosive_compound: 1, tools: 1 }
        , gems: { copper: 5, explosive_compound: 1, refined_clay: 2 }
        , royal_silk: { honey: 4, salted: 2, linen: 3 }
};

// Longitud de un "tick" en segundos (coincide con las tasas anteriores)
const TICK_SECONDS = 10;

// Configuración del generador de recursos (valores por defecto centralizados aquí)
const RESOURCE_GENERATOR_INTERVAL_SECONDS = 10; // intervalo de ejecución del job
const RESOURCE_GENERATOR_WOOD_PER_TICK = 2; // suma fija de madera por tick
const RESOURCE_GENERATOR_STONE_PER_TICK = 1; // suma fija de piedra por tick

// Resource category mapping (lowercase keys)
const RESOURCE_CATEGORIES = {
    // commons
    wood: 'common', stone: 'common', food: 'common', water: 'common', clay: 'common', leather: 'common', coal: 'common', copper: 'common', wool: 'common', honey: 'common',
    // processed
    lumber: 'processed', tools: 'processed', iron_ingot: 'processed', beer: 'processed', baked_brick: 'processed', textile: 'processed', silk_cloth: 'processed', salted: 'processed', refined_clay: 'processed', books: 'processed', purple_dye: 'processed',
    // specialized
    spice: 'specialized', damascus_steel: 'specialized', preservation_elixir: 'specialized', explosive_compound: 'specialized', royal_dye: 'specialized', illustrated_parchment: 'specialized', magic_catalyst: 'specialized',
    // strategic + special categories
    rare_iron: 'strategic', sea_salt: 'strategic', linen: 'strategic', gold_dye: 'strategic', sulfur: 'strategic', precious_gems: 'strategic', silk: 'strategic',
    // Gold is its own category to allow special UI handling
    gold: 'gold'
};


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
    // Producción por recurso (dinámico según claves en PRODUCTION_RATES)
    const production = {};

    if (!Array.isArray(userBuildings)) return production;

    userBuildings.forEach(building => {
        const rate = PRODUCTION_RATES[building.type];
        if (!rate) return;

        const qty = (typeof building.level === 'number')
            ? building.level
            : (typeof building.count === 'number' ? building.count : 0);

        if (qty <= 0) return;

        Object.keys(rate).forEach(resourceKey => {
            production[resourceKey] = (production[resourceKey] || 0) + (rate[resourceKey] || 0) * qty;
        });
    });

    // Consumo de comida por población
    const foodConsumption = (populationStats.current_population || 0) * -FOOD_CONSUMPTION_PER_CITIZEN;
    production.food = (production.food || 0) + foodConsumption;

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

    const scaled = {};
    Object.keys(perTick).forEach(k => {
        scaled[k] = perTick[k] * multiplier;
    });

    const final = {};
    Object.keys(scaled).forEach(k => {
        const v = scaled[k];
        final[k] = v >= 0 ? Math.floor(v) : Math.ceil(v);
    });

    return final;
};

module.exports = {
    // Production rates (per-building)
    PRODUCTION_RATES,
    calculatePopulationStats,
    calculateProduction,
    calculateProductionForDuration,
    // Constantes exportadas
    // Population constants
    BASE_POPULATION,
    POPULATION_PER_HOUSE,
    FOOD_CONSUMPTION_PER_CITIZEN,
    // Tick and generator constants
    TICK_SECONDS,
    RESOURCE_GENERATOR_INTERVAL_SECONDS,
    RESOURCE_GENERATOR_WOOD_PER_TICK,
    RESOURCE_GENERATOR_STONE_PER_TICK,
    MAP_SIZE,
    COORD_RADIUS, // Exportamos el radio de influencia
    findAvailableCoordinates,
    PROCESSING_RECIPES,
    RESOURCE_CATEGORIES
};

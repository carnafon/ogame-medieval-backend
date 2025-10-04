// -----------------------------------------------------------------
// ⭐️ CONSTANTES DE POBLACIÓN Y PRODUCCIÓN
// -----------------------------------------------------------------
const BASE_POPULATION = 10;
const POPULATION_PER_HOUSE = 5;
const FOOD_CONSUMPTION_PER_CITIZEN = 1;

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
const RESOURCE_GENERATOR_INTERVAL_SECONDS = 100; // intervalo de ejecución del job
const RESOURCE_GENERATOR_WOOD_PER_TICK = 2; // suma fija de madera por tick
const RESOURCE_GENERATOR_STONE_PER_TICK = 1; // suma fija de piedra por tick


// -----------------------------------------------------------------
// ⭐️ FUNCIONES AUXILIARES
// -----------------------------------------------------------------

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
    RESOURCE_GENERATOR_STONE_PER_TICK
};





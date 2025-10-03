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

module.exports = {
    calculatePopulationStats,
    calculateProduction
};

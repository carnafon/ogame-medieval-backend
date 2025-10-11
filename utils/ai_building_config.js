/**
 * ai_building_config.js
 * * Contiene la configuración base y las fórmulas de crecimiento exponencial 
 * para los edificios productivos de las Ciudades IA.
 */

// --- CONFIGURACIÓN DE EDIFICIOS ---
const BUILDING_CONFIG = {
    // Nivel C: Comunes (Farm, recursos base)
    'Farm': {
        produces: ['Grano', 'AguaDulce'],
        base_cost: { wood: 500, stone: 300 }, // Usamos las claves de la DB
        base_time_s: 600, // 10 minutos
        base_pop_required: 100,
        factor: { cost: 1.35, time: 1.25, pop: 1.15 } 
    },
    
    // Nivel P: Procesados (Processor, recursos intermedios)
    'Processor': { 
        produces: ['LadrillosReforzados', 'ComidaSalazonada'], 
        base_cost: { wood: 1500, stone: 1000 },
        base_time_s: 1800, // 30 minutos
        base_pop_required: 500,
        factor: { cost: 1.5, time: 1.4, pop: 1.3 }
    },
    
    // Nivel E: Especializados (Refiner, recursos avanzados)
    'Refiner': { 
        produces: ['AceroDamasco', 'TinturaReal'],
        base_cost: { wood: 4000, stone: 3000 },
        base_time_s: 7200, // 2 horas
        base_pop_required: 1200,
        factor: { cost: 1.7, time: 1.6, pop: 1.5 }
    },

    // Nivel S: Estratégicos (StrategicForge, recursos raros)
    'StrategicForge': { 
        produces: ['HierroRaro', 'Seda'],
        base_cost: { wood: 10000, stone: 7500 },
        base_time_s: 18000, // 5 horas
        base_pop_required: 3000,
        factor: { cost: 2.0, time: 1.8, pop: 1.7 } 
    }
};

/**
 * Calcula los requerimientos exponenciales para mejorar un edificio al nivel N+1.
 * @param {string} buildingId - ID del edificio (ej: 'Farm').
 * @param {number} currentLevel - Nivel actual del edificio.
 * @returns {object|null} Requerimientos para el Nivel N+1.
 */
function calculateUpgradeRequirements(buildingId, currentLevel) {
    const config = BUILDING_CONFIG[buildingId];
    if (!config) return null;

    const N = currentLevel; 
    const nextLevel = N + 1;

    // 1. Tiempo (Segundos)
    const requiredTimeS = Math.floor(config.base_time_s * Math.pow(config.factor.time, N));
    
    // 2. Costo (Recursos)
    const requiredCost = {};
    for (const resource in config.base_cost) {
        requiredCost[resource] = Math.floor(config.base_cost[resource] * Math.pow(config.factor.cost, N));
    }
    
    // 3. Población requerida para el NUEVO nivel (N+1)
    const popForNextLevel = Math.floor(config.base_pop_required * Math.pow(config.factor.pop, nextLevel));

    // 4. Población requerida para el NIVEL ACTUAL (N)
    const currentPopRequirement = (N === 0) ? 0 : Math.floor(config.base_pop_required * Math.pow(config.factor.pop, N));

    return {
        nextLevel,
        requiredCost,
        requiredTimeS,
        popForNextLevel,
        currentPopRequirement 
    };
}

module.exports = { BUILDING_CONFIG, calculateUpgradeRequirements };

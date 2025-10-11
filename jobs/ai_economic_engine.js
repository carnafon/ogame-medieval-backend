/**
 * ai_economic_engine.js
 * * Motor principal que debe ser ejecutado periódicamente (e.g., cada 1 minuto) 
 * * mediante un cron job para simular la actividad de las ciudades IA.
 */

// Usamos require() para importar la configuración de la carpeta utils
const { calculateUpgradeRequirements, BUILDING_CONFIG } = require('../utils/ai_building_config');

/**
 * Procesa la lógica económica (construcción, producción, comercio) para todas las ciudades IA.
 * @param {object} pool - Instancia de la conexión a PostgreSQL (pg.Pool).
 */
async function runEconomicUpdate(pool) {
    try {
        console.log(`[AI Engine] Iniciando actualización económica de ciudades IA.`);

        // 1. Obtener todas las ciudades IA de la base de datos (ai_cities)
        const aiCitiesResult = await pool.query('SELECT * FROM ai_cities FOR UPDATE'); // Usar FOR UPDATE para evitar concurrencia
        const aiCities = aiCitiesResult.rows;
        
        const now = new Date();

        for (const city of aiCities) {
            
            // --- A. GESTIONAR FINALIZACIÓN DE CONSTRUCCIÓN ---
            // city.current_construction es un objeto JSONB o null
            if (city.current_construction && new Date(city.current_construction.finish_time) <= now) {
                await completeConstruction(pool, city);
            }

            // --- B. DECISIÓN DE INICIO DE NUEVA CONSTRUCCIÓN ---
            // Solo si la ciudad no está ya construyendo algo.
            if (!city.current_construction) {
                await decideNewConstruction(pool, city);
            }
            
            // --- C. (TODO) GESTIONAR PRODUCCIÓN DE RECURSOS ---
            // Lógica pendiente
        }

        console.log(`[AI Engine] Actualización económica finalizada con éxito.`);
    } catch (err) {
        console.error('[AI Engine] Error crítico en runEconomicUpdate:', err.message);
    }
}


/**
 * Completa la construcción pendiente de un edificio.
 */
async function completeConstruction(pool, city) {
    // Nota: El objeto en la DB debe usar snake_case: finish_time, level_to_upgrade, etc.
    const { building_id, level_to_upgrade } = city.current_construction; 

    // Calcular el delta de población que ahora requiere el nuevo nivel
    const reqs = calculateUpgradeRequirements(building_id, level_to_upgrade - 1); 
    if (!reqs) return;

    // La población consumida aumenta por la diferencia de requerimiento entre el nuevo nivel y el anterior
    const popDelta = reqs.popForNextLevel - reqs.currentPopRequirement;
    
    // 1. Actualizar el nivel del edificio en el mapa 'buildings'
    // city.buildings es un objeto JSONB (ej: { "Farm": 5, "Processor": 2 })
    const newBuildings = { ...city.buildings, [building_id]: level_to_upgrade };
    
    // 2. Actualizar la población consumida (pop_consumed)
    const newPopConsumed = city.pop_consumed + popDelta;

    const query = `
        UPDATE ai_cities
        SET 
            buildings = $1,
            pop_consumed = $2,
            current_construction = NULL
        WHERE id = $3;
    `;
    await pool.query(query, [newBuildings, newPopConsumed, city.id]);
    
    console.log(`[AI Engine] ✅ Construcción finalizada en ${city.name}: ${building_id} Nivel ${level_to_upgrade}.`);
}


/**
 * Decide e inicia una nueva construcción basada en las necesidades de la ciudad.
 */
async function decideNewConstruction(pool, city) {
    // Lógica: Priorizar el edificio de menor nivel (balanceado).
    let bestUpgrade = null;
    let lowestLevel = Infinity;

    // Buscar el edificio con el nivel más bajo (o 0 si no existe)
    for (const buildingId in BUILDING_CONFIG) {
        const currentLevel = city.buildings[buildingId] || 0;

        if (currentLevel < lowestLevel) {
            lowestLevel = currentLevel;
            bestUpgrade = buildingId;
        }
    }

    if (!bestUpgrade) return;

    const currentLevel = city.buildings[bestUpgrade] || 0;
    const reqs = calculateUpgradeRequirements(bestUpgrade, currentLevel);

    if (!reqs) return;

    // --- Chequeo de Población ---
    const availablePop = city.population - city.pop_consumed;
    const popRequiredDelta = reqs.popForNextLevel - reqs.currentPopRequirement;

    if (availablePop < popRequiredDelta) {
        // La IA no construye si no tiene población libre
        console.log(`[AI Engine] ⚠️ ${city.name} necesita más población para mejorar ${bestUpgrade}. Pop Libre: ${availablePop}, Necesario: ${popRequiredDelta}.`);
        return;
    }

    // --- Chequeo de Recursos ---
    let hasEnoughResources = true;
    for (const resource in reqs.requiredCost) {
        // city.resources es un objeto JSONB (ej: { "wood": 10000, "stone": 5000 })
        if ((city.resources[resource] || 0) < reqs.requiredCost[resource]) {
            hasEnoughResources = false;
            break;
        }
    }

    if (hasEnoughResources) {
        // Iniciar la construcción!
        const finishTime = new Date(new Date().getTime() + reqs.requiredTimeS * 1000);

        const newConstruction = {
            building_id: bestUpgrade,
            level_to_upgrade: reqs.nextLevel,
            finish_time: finishTime.toISOString() // Usamos finish_time para la DB
        };

        // 1. Descontar los recursos
        const newResources = { ...city.resources };
        for (const resource in reqs.requiredCost) {
            newResources[resource] -= reqs.requiredCost[resource];
        }
        
        // 2. Actualizar la base de datos
        const query = `
            UPDATE ai_cities
            SET 
                resources = $1,
                current_construction = $2
            WHERE id = $3;
        `;
        await pool.query(query, [newResources, newConstruction, city.id]);
        
        console.log(`[AI Engine] 🛠️ Construcción iniciada en ${city.name}: ${bestUpgrade} Nivel ${reqs.nextLevel}.`);

    } else {
        console.log(`[AI Engine] ❌ ${city.name} no tiene suficientes recursos para mejorar ${bestUpgrade}.`);
        // Lógica de comercio pendiente...
    }
}


// Exportar la función para que el script de cron pueda llamarla
module.exports = { runEconomicUpdate };

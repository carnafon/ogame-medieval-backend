const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { calculatePopulationStats, calculateProduction, calculateProductionForDuration } = require('../utils/gameUtils'); // Importamos funciones de utilidad
const { authenticateToken } = require('../middleware/auth'); // Importamos el middleware centralizado

// -----------------------------------------------------------------
// ⭐️ CONSTANTES
// -----------------------------------------------------------------

const POPULATION_CHANGE_RATE = 1; 

// Definir costes de construcción
const BUILDING_COSTS = {
    'house': { wood: 20, stone: 10, food: 5 },
    'sawmill': { wood: 50, stone: 30, food: 10 },
    'quarry': { wood: 40, stone: 80, food: 15 },
    'farm': { wood: 40, stone: 10, food: 10 }
};

// -----------------------------------------------------------------
// ⭐️ RUTAS PROTEGIDAS (authenticateToken se ejecuta en index.js)
// -----------------------------------------------------------------

// RUTA CONSTRUCCION
router.post('/build', async (req, res) => {
    // userId viene de req.user.id gracias al middleware authenticateToken en index.js
    const userId = req.user.id; 
    const { buildingType } = req.body; 

    const cost = BUILDING_COSTS[buildingType];
    if (!cost) {
        return res.status(400).json({ message: 'Tipo de edificio no válido.' });
    }

    const client = await pool.connect(); 

    try {
        await client.query('BEGIN'); 

        // 1. Obtener recursos, población y timestamp del último update
        // Nota: la tabla users debería tener la columna last_resource_update (timestamp without time zone)
        // Si no existe, ejecutar en la DB:
        // ALTER TABLE users ADD COLUMN last_resource_update TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();
        const currentResources = await client.query(
            'SELECT wood, stone, food, current_population, last_resource_update FROM users WHERE id = $1 FOR UPDATE', 
            [userId]
        );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        const dbRow = currentResources.rows[0];
        const user = {
            wood: parseInt(dbRow.wood, 10),
            stone: parseInt(dbRow.stone, 10),
            food: parseInt(dbRow.food, 10),
            current_population: parseInt(dbRow.current_population, 10),
            last_resource_update: dbRow.last_resource_update ? new Date(dbRow.last_resource_update) : new Date()
        };

        // Acumular producción pendiente desde last_resource_update (lazy accrual)
        const now = new Date();
        const secondsElapsed = Math.max(0, Math.floor((now - user.last_resource_update) / 1000));
        if (secondsElapsed > 0) {
            const buildingCountResultTemp = await client.query(
                'SELECT type, COUNT(*) as count FROM buildings WHERE user_id = $1 GROUP BY type',
                [userId]
            );
            const buildingsListTemp = buildingCountResultTemp.rows.map(r => ({ type: r.type, count: parseInt(r.count, 10) }));
            const popStatsForCalc = calculatePopulationStats(buildingsListTemp, user.current_population);
            const accrued = calculateProductionForDuration(buildingsListTemp, popStatsForCalc, secondsElapsed);

            user.wood += accrued.wood;
            user.stone += accrued.stone;
            user.food = Math.max(0, user.food + accrued.food);

            // actualizar recursos y timestamp antes de intentar construir
            await client.query(
                `UPDATE users SET wood = $1, stone = $2, food = $3, last_resource_update = $4 WHERE id = $5`,
                [user.wood, user.stone, user.food, now.toISOString(), userId]
            );
        }

        // 2. Verificar si hay suficientes recursos
        if (user.wood < cost.wood || user.stone < cost.stone || user.food < cost.food) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Recursos insuficientes para construir.' });
        }

        // 3. Deducir los recursos y obtener los datos actualizados
        const updatedResources = await client.query(
            `UPDATE users SET
                wood = wood - $1,
                stone = stone - $2,
                food = food - $3,
                last_resource_update = $5
             WHERE id = $4
             RETURNING wood, stone, food, username, current_population`,
            [cost.wood, cost.stone, cost.food, userId, new Date().toISOString()]
        );

        const updatedUser = updatedResources.rows[0];

        // 4. Registrar el nuevo edificio
        await client.query(
            'INSERT INTO buildings (user_id, type) VALUES ($1, $2)',
            [userId, buildingType]
        );

        await client.query('COMMIT'); 

        // 5. Obtener lista de edificios y estadísticas de población
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
                current_population: parseInt(updatedUser.current_population, 10),
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

// RUTA: Generación periódica de recursos
router.post('/generate-resources', async (req, res) => {
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
        
        // 2. Obtener recursos, población y last_resource_update del usuario
        const currentResources = await client.query(
            'SELECT wood, stone, food, current_population, last_resource_update FROM users WHERE id = $1 FOR UPDATE', 
            [userId]
        );

        if (currentResources.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        
        const dbRow = currentResources.rows[0];
        const user = {
            wood: parseInt(dbRow.wood, 10),
            stone: parseInt(dbRow.stone, 10),
            food: parseInt(dbRow.food, 10),
            current_population: parseInt(dbRow.current_population, 10),
            last_resource_update: dbRow.last_resource_update ? new Date(dbRow.last_resource_update) : new Date()
        };

        // Acumular producción pendiente desde last_resource_update (lazy accrual)
        const now = new Date();
        const secondsElapsed = Math.max(0, Math.floor((now - user.last_resource_update) / 1000));
        if (secondsElapsed > 0) {
            const popStatsForCalcTemp = calculatePopulationStats(buildingsList, user.current_population);
            const accrued = calculateProductionForDuration(buildingsList, popStatsForCalcTemp, secondsElapsed);

            user.wood += accrued.wood;
            user.stone += accrued.stone;
            user.food = Math.max(0, user.food + accrued.food);

            // persistir recursos acumulados antes de calcular el tick actual
            await client.query(
                `UPDATE users SET wood = $1, stone = $2, food = $3, last_resource_update = $4 WHERE id = $5`,
                [user.wood, user.stone, user.food, now.toISOString(), userId]
            );
        }

        // 3. Calcular estadísticas de población y producción (ya con recursos actualizados)
        const populationStats = calculatePopulationStats(buildingsList, user.current_population);
        const production = calculateProduction(buildingsList, populationStats);
        
        // 4. Lógica de Población Dinámica
        let newPopulation = populationStats.current_population;
        const maxPopulation = populationStats.max_population;
        const netFoodProduction = production.food;

        if (netFoodProduction >= 0) {
            newPopulation = Math.min(maxPopulation, newPopulation + POPULATION_CHANGE_RATE);
        } else {
            newPopulation = Math.max(1, newPopulation - POPULATION_CHANGE_RATE);
        }
        
        // 5. Aplicar producción
        const newWood = user.wood + production.wood;
        const newStone = user.stone + production.stone;
        const newFood = Math.max(0, user.food + netFoodProduction); 

                // 6. Actualizar la base de datos (recursos, población y last_resource_update)
                const updatedResources = await client.query(
                        `UPDATE users SET
                                wood = $1,
                                stone = $2,
                                food = $3,
                                current_population = $5,
                                last_resource_update = $6
                            WHERE id = $4
                            RETURNING wood, stone, food, username, current_population`,
                        [newWood, newStone, newFood, userId, newPopulation, now.toISOString()]
                );

        await client.query('COMMIT'); 

        const updatedUser = updatedResources.rows[0];

        // 7. Recalcular las estadísticas con la nueva población guardada para la respuesta
        const finalPopulationStats = calculatePopulationStats(buildingsList, parseInt(updatedUser.current_population, 10));

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

module.exports = router;
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { getResources, setResourcesWithClient } = require('../utils/resourcesService');
const { getBuildings } = require('../utils/buildingsService');
const populationService = require('../utils/populationService');

/* ======================================================
   ENTIDADES (jugadores, IA, NPCs, etc.)
   ====================================================== */

/**
 * GET /entities
 * Devuelve todas las entidades del juego.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, faction_id, type, x_coord, y_coord, population
       FROM entities`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error obteniendo entidades', error: err.message });
  }
});

/**
 * GET /entities/:id
 * Devuelve los datos de una entidad específica.
 */
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT e.id, e.user_id, e.faction_id, e.type, e.x_coord, e.y_coord, e.population, f.name AS faction_name, u.username
       FROM entities e
       LEFT JOIN factions f ON f.id = e.faction_id
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entidad no encontrada' });
    }

    const entity = result.rows[0];

    // gather resources, buildings and population summary using helpers
    const resources = await getResources(id);
    let buildings = [];
    try {
      buildings = await getBuildings(id);
    } catch (bErr) {
      console.warn('No buildings available or error reading buildings for entity', id, bErr.message);
    }
    const popSummary = await populationService.getPopulationSummary(id);

    res.status(200).json({
      ...entity,
      resources: Object.keys(resources).map(name => ({ name, amount: resources[name] })),
      buildings,
      population: {
        current_population: popSummary.total || 0,
        max_population: popSummary.max || 0,
        available_population: popSummary.available || 0,
        breakdown: popSummary.breakdown || {}
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error obteniendo entidad', error: err.message });
  }
});

/**
 * POST /entities
 * Crea una nueva entidad (jugador, IA, etc.).
 */
router.post('/', authenticateToken, async (req, res) => {
  const { user_id, faction_id, type, x_coord, y_coord, population } = req.body;

  if (!type || x_coord == null || y_coord == null) {
    return res.status(400).json({ message: 'Faltan campos obligatorios: type, x_coord, y_coord' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO entities (user_id, faction_id, type, x_coord, y_coord, population)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id || null, faction_id || null, type, x_coord, y_coord, population || 0]
    );

    res.status(201).json({
      message: 'Entidad creada correctamente',
      entity: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error creando entidad', error: err.message });
  }
});

/**
 * PATCH /entities/:id
 * Actualiza datos de una entidad (posición, población, facción, etc.).
 */
router.patch('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { x_coord, y_coord, population, faction_id, type } = req.body;

  try {
    const fields = [];
    const values = [];
    let index = 1;

    if (x_coord != null) { fields.push(`x_coord = $${index++}`); values.push(x_coord); }
    if (y_coord != null) { fields.push(`y_coord = $${index++}`); values.push(y_coord); }
    if (population != null) { fields.push(`population = $${index++}`); values.push(population); }
    if (faction_id != null) { fields.push(`faction_id = $${index++}`); values.push(faction_id); }
    if (type != null) { fields.push(`type = $${index++}`); values.push(type); }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron campos para actualizar' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE entities SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entidad no encontrada' });
    }

    res.status(200).json({ message: 'Entidad actualizada', entity: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error actualizando entidad', error: err.message });
  }
});

/**
 * DELETE /entities/:id
 * Elimina una entidad del juego.
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM entities WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entidad no encontrada' });
    }
    res.status(200).json({ message: 'Entidad eliminada', deleted: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error eliminando entidad', error: err.message });
  }
});

/* ======================================================
   RECURSOS DE ENTIDADES
   ====================================================== */

/**
 * GET /entities/:id/resources
 * Devuelve los recursos de una entidad.
 */
router.get('/:id/resources', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const resources = await getResources(id);
    // Return in similar shape (array with id/name/amount) — resource_type_id is not available from getResources, return name/amount
    res.status(200).json({
      entity_id: parseInt(id, 10),
      resources: Object.keys(resources).map(name => ({ name, amount: resources[name] }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error obteniendo recursos', error: err.message });
  }
});

/**
 * PATCH /entities/:id/resources
 * Modifica (aumenta o reduce) los recursos de una entidad.
 */
router.patch('/:id/resources', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { updates } = req.body; // [{ resource_type_id, amount_change }]

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ message: 'Se requiere un array de actualizaciones' });
  }

  try {
    // Read current resources, apply deltas, and write back within one transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await getResources(id);
      const newResources = { ...current };
      for (const { resource_type_id, amount_change } of updates) {
        // We need to map resource_type_id -> name; query it
        const rt = await client.query('SELECT name FROM resource_types WHERE id = $1', [resource_type_id]);
        if (rt.rows.length === 0) throw new Error(`Tipo de recurso no encontrado: ${resource_type_id}`);
        const name = rt.rows[0].name.toLowerCase();
        newResources[name] = Math.max(0, (newResources[name] || 0) + (amount_change || 0));
      }

      // Persist using client
      await setResourcesWithClient(client, id, newResources);
      await client.query('COMMIT');
      res.json({ message: 'Inventario actualizado correctamente.', resources: newResources });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar recursos', error: err.message });
  }
});

module.exports = router;

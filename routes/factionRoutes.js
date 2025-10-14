app.get('/api/factions', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id, name FROM factions ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error obteniendo facciones' });
  }
});

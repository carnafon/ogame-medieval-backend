const { Pool } = require('pg');

// Conexión a la base de datos de Neon a través de la variable de entorno
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necesario para bases de datos como Neon en algunos entornos
  }
});

module.exports = pool; // Exportamos el pool para usarlo en otros archivos

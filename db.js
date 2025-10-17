const { Pool } = require('pg');

// Conexión a la base de datos de Neon a través de la variable de entorno
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necesario para bases de datos como Neon en algunos entornos
  }
});

// When a new client is created/checked out we set some defensive session settings
// and attach an error handler to avoid unhandled 'error' events which crash the process.
pool.on('connect', (client) => {
	try {
		// Ensure statements time out reasonably to avoid long-running transactions
		// (value in ms) - adjust as needed
		const DEFAULT_STATEMENT_TIMEOUT_MS = 60000; // 60s
		client.query(`SET statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`).catch(() => {});

		// Attach an error listener on the client instance to log unexpected errors
		client.on('error', (err) => {
			console.error('[PG Client] unexpected error on client', err && err.stack ? err.stack : err);
		});
	} catch (e) {
		console.error('[PG Pool] error during connect handler', e && e.stack ? e.stack : e);
	}
});

// Pool-level error (e.g., idle client error)
pool.on('error', (err, client) => {
	console.error('[PG Pool] idle client error', err && err.stack ? err.stack : err);
});

module.exports = pool; // Exportamos el pool para usarlo en otros archivos

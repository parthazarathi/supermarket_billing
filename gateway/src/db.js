// pg is required lazily so modules load without the dependency or DATABASE_URL.
function createPool(config) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000
  });
}

module.exports = { createPool };

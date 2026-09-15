const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createPool } = require('./db');
const { createApp } = require('./app');
const { startWorker, metaFactory } = require('./queueWorker');
const { redactText } = require('./redact');

async function main() {
  const config = loadConfig();
  const pool = createPool(config);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);

  const deps = { config, pool, metaFor: metaFactory(config) };
  const app = createApp(deps);
  const stopWorker = startWorker(deps);

  const server = app.listen(config.port, () => {
    console.log(`MartPOS gateway listening on :${config.port}`);
  });

  const shutdown = () => {
    stopWorker();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Gateway failed to start:', redactText(e.message || 'error'));
    process.exit(1);
  });
}

module.exports = { main };

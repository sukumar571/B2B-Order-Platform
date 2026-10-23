'use strict';

/**
 * Run versioned migrations (node-pg-migrate) against the dev or test database.
 *
 *   node scripts/db/migrate.js up          # apply pending migrations (dev)
 *   node scripts/db/migrate.js down        # revert the last migration (dev)
 *   node scripts/db/migrate.js down --all  # revert everything (dev)
 *   node scripts/db/migrate.js up --test   # against DATABASE_URL_TEST
 *
 * Safety: this script only ever creates/alters schema objects listed in the
 * migration files. It never drops a database and never truncates data.
 * `down` reverts individual migrations reversibly (docs/database-design.md §4).
 */

const path = require('path');
const pm = require('node-pg-migrate');
const migrate = pm.default || pm; // v7 CommonJS builds expose the runner as .default
const config = require('../../src/config/env'); // also loads backend/.env

const [directionArg, ...rest] = process.argv.slice(2);
const direction = directionArg === 'down' ? 'down' : 'up';
const useTestDb = rest.includes('--test');
const revertAll = rest.includes('--all');

const databaseUrl = useTestDb ? config.databaseUrlTest : config.databaseUrl;

if (!databaseUrl) {
  console.error(
    `Error: ${useTestDb ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is not set. ` +
      'Copy backend/.env.example to backend/.env (or pass the env var) first.'
  );
  process.exit(1);
}

const options = {
  direction,
  databaseUrl,
  dir: path.join(__dirname, '..', '..', 'migrations'),
  migrationsTable: 'pgmigrations',
  schema: 'public',
  verbose: true,
  log: (msg) => console.log(msg),
};
if (direction === 'down' && revertAll) options.count = 0;
if (direction === 'down' && !revertAll) options.count = 1;

migrate(options)
  .then(() => {
    console.log(`Migrations ${direction} completed against ${redact(databaseUrl)}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Migration ${direction} failed:`, err.message);
    process.exit(1);
  });

/** Hide credentials when echoing the connection string. */
function redact(url) {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

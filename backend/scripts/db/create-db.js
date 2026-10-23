'use strict';

/**
 * Safely create the development or test database if it does not exist.
 *
 *   node scripts/db/create-db.js          # create the DATABASE_URL database
 *   node scripts/db/create-db.js --test   # create the DATABASE_URL_TEST database
 *
 * Safety contract (NFR-14 / risk-register R-05):
 *  - Connects to the maintenance database (`postgres`) on the same server.
 *  - Issues CREATE DATABASE only when the target is missing.
 *  - NEVER drops anything and never touches existing tables or rows.
 *  - CREATE DATABASE cannot run parameterized, so the identifier is taken
 *    from the connection-string path and validated against a strict pattern
 *    before being quoted.
 */

const { Client } = require('pg');
const config = require('../../src/config/env');

const useTestDb = process.argv.includes('--test');
const targetUrl = useTestDb ? config.databaseUrlTest : config.databaseUrl;

if (!targetUrl) {
  console.error(
    `Error: ${useTestDb ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is not set. ` +
      'Copy backend/.env.example to backend/.env (or pass the env var) first.'
  );
  process.exit(1);
}

const url = new URL(targetUrl.replace('postgres://', 'postgresql://'));
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) {
  console.error(`Refusing to create database with unsafe name: "${dbName}"`);
  process.exit(1);
}

// Connect to the maintenance db on the same server to issue CREATE DATABASE.
url.pathname = '/postgres';

(async () => {
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // dbName matches ^[a-z_][a-z0-9_]{0,62}$ (validated above), so quoting
      // it directly is injection-safe; CREATE DATABASE cannot be parameterized.
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database "${dbName}".`);
    } else {
      console.log(`Database "${dbName}" already exists — nothing to do (no data was touched).`);
    }
  } catch (err) {
    console.error(`create-db failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();

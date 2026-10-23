'use strict';

const config = require('./config/env');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const { closePool } = require('./db/pool');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, env: config.nodeEnv });
});

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * drain, then exit. A hard timeout guarantees exit even if sockets hang.
 * (docs/requirements.md NFR-12; risk-register R-05/R-07.)
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown.initiated', { signal });

  const forceTimer = setTimeout(() => {
    logger.error('server.shutdown.timedout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceTimer.unref();

  server.close(async (err) => {
    if (err) {
      logger.error('server.shutdown.error', { message: err.message });
      return process.exit(1);
    }
    // Drain in-flight DB queries via the pool before exiting (NFR-12).
    await closePool().catch((poolErr) =>
      logger.error('server.shutdown.pool_error', { message: poolErr.message })
    );
    clearTimeout(forceTimer);
    logger.info('server.shutdown.complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Never leave an unhandled rejection silently — log and let process managers restart.
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandledRejection', { reason: String(reason) });
});

module.exports = { server, shutdown };

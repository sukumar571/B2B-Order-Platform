'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const routes = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { notFoundHandler } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');

/**
 * Build a fully configured Express app.
 * Exported as a factory so tests can create isolated instances
 * without starting a network listener (docs/architecture.md §4).
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Security headers (requirements.md §Security / NFR).
  app.use(
    helmet({
      contentSecurityPolicy: false, // API-only service; CSP configured with the SPA later.
    })
  );

  // Explicitly configured CORS allow-list from env (no wildcard).
  const corsHandler = buildCors(config.corsOrigins);
  app.use(corsHandler);

  // JSON request parsing with a bounded payload size.
  app.use(express.json({ limit: config.jsonBodyLimit }));

  // Cookies — only the auth layer reads them (HttpOnly refresh token).
  app.use(cookieParser());

  // Structured access logging (metadata only).
  if (!config.isTest) app.use(requestLogger);

  // Routers.
  app.use(routes);

  // Consistent 404 + centralized safe error handling (must be last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Returns a cors middleware. When the allow-list is empty, CORS is effectively
 * disabled (same-origin only) — a safe default. Otherwise only listed origins
 * are echoed back.
 */
function buildCors(origins) {
  if (!origins || origins.length === 0) {
    return (_req, _res, next) => next();
  }
  const allow = new Set(origins);
  return cors({
    origin: (origin, callback) => {
      // Non-browser clients send no Origin header — allow them.
      if (!origin || allow.has(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  });
}

module.exports = { createApp };

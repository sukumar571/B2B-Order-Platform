# ---------------------------------------------------------------------------
# Production image for the Express API (CommonJS, no build step).
# Build context = the ./backend directory (see docker-compose.yml).
#
# Security posture:
#   - .env files are excluded by .dockerignore and never COPY'd, so no
#     development secrets enter the image (requirements.md C-06).
#   - Demo seed data is NOT baked in; `docker compose --profile deploy run
#     --rm seed` bind-mounts ../../database/seeds read-only at run time.
#   - Runs as the unprivileged built-in `node` user.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

# Install only production dependencies from the committed lockfile for
# reproducible builds (docs/decision-log.md dependency locking).
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Final runtime image ------------------------------------------------
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Application source is owned by root and NOT world-writable; the node user
# only needs read access (the API writes nothing to disk).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Container-level health check (compose honours it too). Uses Node 18+ fetch.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the unprivileged built-in user.
USER node

EXPOSE 4000
CMD ["node", "src/server.js"]

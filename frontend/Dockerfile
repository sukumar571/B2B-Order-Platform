# ---------------------------------------------------------------------------
# Multi-stage: build the Vite SPA, then serve the static bundle with nginx.
# Build context = the ./frontend directory (see docker-compose.yml).
#
# Only the files needed to build are copied (never `.env` — .dockerignore
# excludes it, so no secrets or dev-only VITE_ values reach the bundle).
# The SPA calls the relative path /api, which nginx proxies to the backend
# service, so no API origin has to be baked in at build time.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Dependency layer — invalidated only when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Source layer.
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# --- Serve stage ---------------------------------------------------------
FROM nginx:1.27-alpine AS serve

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# nginx:alpine ships with curl; probe the SPA root and the proxied API health.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1/ >/dev/null && curl -fsS http://127.0.0.1/api/health >/dev/null || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

# syntax=docker/dockerfile:1.7

# ── Stage 1: install deps ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json* ./

# If a lockfile exists use npm ci for reproducible installs; otherwise fall
# back to npm install. tsx is a prod dep so we install the full tree.
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi


# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

# Non-root user — standard hardening
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

USER app
EXPOSE 3000

# Basic liveness check; Docker marks the container unhealthy if /health stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]

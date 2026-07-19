# Multi-stage build for the ForeverBetter API.
# The same image is reused for the API, the WGS worker, and the wearables
# worker. The process is chosen by the PROCESS env var (see docker-entrypoint.sh).

# ---- builder ----
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bcftools tabix gzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production-only deps. The runtime calls the pinned tsx binary directly, so
# remove npm and npx after installation to keep npm's own dependency tree out
# of the production image and vulnerability surface.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Built JS
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
COPY data/genetics ./data/genetics

# Ship sources so the genetics worker can run the vendored TypeScript analysis
# pipeline with the production-pinned tsx dependency.
COPY --from=builder /app/src ./src
COPY tsconfig.json tsconfig.build.json ./

# Bundled analyze-health skill used by the background health analysis worker.
# Request-specific analysis and WGS readiness files are written to the job's
# output directory, leaving this shipped source bundle unchanged.
COPY --chown=node:node vendor/health-analysis-skill ./vendor/health-analysis-skill
ENV HEALTH_ANALYSIS_SKILL_DIR=/app/vendor/health-analysis-skill

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default filesystem payload directory. Owned by node so a fresh named volume
# mounted here (docker-compose) inherits writable ownership for the non-root user.
RUN mkdir -p /data/payloads && chown -R node:node /data
ENV PAYLOAD_DIR=/data/payloads

EXPOSE 8787
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

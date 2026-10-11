# syntax=docker/dockerfile:1.7
#
# Constans — multi-stage image. Final image: Node 24 on Alpine, non-root, no build tooling,
# safe to run with a read-only root filesystem (it writes only to /data and /tmp).

ARG NODE_VERSION=24

# ---------- build: compile TypeScript
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY core ./core
COPY schemas ./schemas
COPY security ./security
COPY capabilities ./capabilities
COPY state ./state
COPY orchestration ./orchestration
COPY insight ./insight
COPY nexora ./nexora
COPY authoring ./authoring
COPY gateway ./gateway
COPY cli ./cli
COPY server ./server
RUN npm run build

# ---------- deps: production dependencies only
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------- runtime
FROM node:${NODE_VERSION}-alpine AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Constans" \
      org.opencontainers.image.description="AI workflow substrate: declarative, deterministic, auditable workflows" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary" \
      org.opencontainers.image.version="${VERSION}"

# tini reaps zombies and forwards signals, so shutdown is graceful and shell steps cannot linger.
RUN apk add --no-cache tini \
 && addgroup -S -g 10001 constans \
 && adduser -S -u 10001 -G constans -h /app constans \
 && mkdir -p /data /etc/constans/policies \
 && chown -R constans:constans /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# ^ the runtime never runs npm; dropping it removes the base image's bundled npm (and its CVEs) from the image.

WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    CONSTANS_DATA_DIR=/data \
    CONSTANS_HOST=0.0.0.0 \
    CONSTANS_PORT=8080 \
    CONSTANS_POLICY_DIR=/etc/constans/policies \
    CONSTANS_WORKFLOWS_DIR=/app/workflows

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE ./
COPY console ./console
COPY workflows ./workflows

# `constans` on the PATH: `docker exec <container> constans admin doctor`
RUN chmod +x dist/cli/main.js && ln -s /app/dist/cli/main.js /usr/local/bin/constans

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/main.js"]

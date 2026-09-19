# syntax=docker/dockerfile:1.7
#
# OmniFlow — multi-stage image. Final image: Node 24 on Alpine, non-root, no build tooling,
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
LABEL org.opencontainers.image.title="OmniFlow" \
      org.opencontainers.image.description="AI workflow substrate: declarative, deterministic, auditable workflows" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# tini reaps zombies and forwards signals, so shutdown is graceful and shell steps cannot linger.
RUN apk add --no-cache tini \
 && addgroup -S -g 10001 omniflow \
 && adduser -S -u 10001 -G omniflow -h /app omniflow \
 && mkdir -p /data /etc/omniflow/policies \
 && chown -R omniflow:omniflow /data

WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    OMNIFLOW_DATA_DIR=/data \
    OMNIFLOW_HOST=0.0.0.0 \
    OMNIFLOW_PORT=8080 \
    OMNIFLOW_POLICY_DIR=/etc/omniflow/policies \
    OMNIFLOW_WORKFLOWS_DIR=/app/workflows

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE ./
COPY console ./console
COPY workflows ./workflows

# `omniflow` on the PATH: `docker exec <container> omniflow admin doctor`
RUN chmod +x dist/cli/main.js && ln -s /app/dist/cli/main.js /usr/local/bin/omniflow

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/main.js"]

# syntax=docker/dockerfile:1
#
# CLPRouter services image: event indexer, route status API, quote service and forward trigger.
# Build from the repository root:
#   docker build -f .github/docker/services.Dockerfile -t clprouter-services .
# Run:
#   docker run --rm -p 8787:8787 -v "$PWD/config.json:/config/config.json:ro" clprouter-services
# The config must set "http": {"host": "0.0.0.0"} to be reachable from outside the container.
# The forward trigger signs only against local RPC URLs and reads its key from the environment
# (CLPROUTER_TRIGGER_KEY by default); never bake a key into the image.

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS base

FROM base AS deps
ARG PNPM_VERSION=12.6.0
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app
# The services compile the planner SDK from source (tsconfig paths), so both packages ship.
COPY sdk/package.json sdk/pnpm-lock.yaml sdk/
COPY services/package.json services/pnpm-lock.yaml services/pnpm-workspace.yaml services/
RUN cd sdk && pnpm install --frozen-lockfile --prod \
 && cd ../services && pnpm install --frozen-lockfile

FROM base AS runtime
LABEL org.opencontainers.image.title="clprouter-services" \
      org.opencontainers.image.description="CLPRouter indexer, route status API, quote service and forward trigger" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    CLPROUTER_SERVICES_CONFIG=/config/config.json
WORKDIR /app
COPY --from=deps --chown=node:node /app/sdk/node_modules sdk/node_modules
COPY --from=deps --chown=node:node /app/services/node_modules services/node_modules
COPY --chown=node:node sdk/package.json sdk/tsconfig.json sdk/
COPY --chown=node:node sdk/src sdk/src
COPY --chown=node:node services/package.json services/tsconfig.json services/
COPY --chown=node:node services/src services/src
RUN mkdir -p /data /config && chown node:node /data /config
USER node
WORKDIR /app/services
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]

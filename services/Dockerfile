# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: MIT
# CLPRouter services image. Build from the repository root (the services import the SDK source):
#   docker build -f services/Dockerfile -t clprouter-services .
# Base images are pinned by digest; bump them deliberately (docker buildx imagetools inspect node:24-bookworm-slim).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ── build: install with the lockfiles, bundle to one file ─────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
WORKDIR /src
COPY sdk/package.json sdk/pnpm-lock.yaml sdk/
COPY services/package.json services/pnpm-lock.yaml services/pnpm-workspace.yaml services/
RUN cd sdk && pnpm install --frozen-lockfile --prod --ignore-scripts \
 && cd ../services && pnpm install --frozen-lockfile --ignore-scripts
COPY sdk/src sdk/src
COPY services/tsconfig.json services/openapi.json services/
COPY services/scripts/build.mjs services/scripts/
COPY services/src services/src
RUN cd services && node scripts/build.mjs

# ── runtime: no package manager, no node_modules, non-root ────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    CLPROUTER_HTTP_HOST=0.0.0.0 \
    CLPROUTER_HTTP_PORT=8787
WORKDIR /app
COPY --from=build --chown=root:root /src/services/dist/ dist/
COPY --from=build --chown=root:root /src/services/openapi.json openapi.json
# SQLite (when used) lives on a volume owned by the unprivileged user; the code itself stays read-only to it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node:node
EXPOSE 8787 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CLPROUTER_HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]

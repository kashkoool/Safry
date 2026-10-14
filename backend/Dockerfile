# syntax=docker/dockerfile:1
# Targets:
#   runtime (default, last stage)  the long-running API: production dependencies + compiled dist only, runs as "node".
#   migrate                        one-off job image (Debian, full toolchain): Prisma CLI + migrations (default command) and the opt-in seed.
#                                  Never serves traffic; exits when done. See docs/DEPLOYMENT.md.
# Base images are pinned by tag AND digest. Dependabot (.github/dependabot.yml, "docker" ecosystem) bumps both together.

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
# Exact pnpm version with registry integrity hashes (tools/pnpm/package-lock.json, installed by npm ci; the project lockfile is written by pnpm 11): the package manager is part of the supply chain.
COPY tools/pnpm/package.json tools/pnpm/package-lock.json /opt/pnpm/
RUN npm ci --ignore-scripts --prefix /opt/pnpm && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec prisma generate && pnpm exec nest build

# Production dependencies only, resolved from the same lockfile, on the same OS (musl) as the runtime
# so native modules (argon2) get the matching prebuilt binary.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS prod-deps
COPY tools/pnpm/package.json tools/pnpm/package-lock.json /opt/pnpm/
RUN npm ci --ignore-scripts --prefix /opt/pnpm && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM build AS migrate
ENV NODE_ENV=production
# Prisma's schema engine needs OpenSSL (otherwise it warns and guesses openssl-1.1.x).
# perl-base is upgraded explicitly: the pinned base image still ships a version with fixed HIGH/CRITICAL advisories.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && apt-get install -y --only-upgrade perl-base && rm -rf /var/lib/apt/lists/*
# Fetch the schema engine for this OpenSSL at BUILD time (as root). At run time the job runs as `node` on a read-only filesystem and
# cannot download it, which fails with "Can't write to .../@prisma/engines".
RUN node node_modules/prisma/build/index.js --version
# argon2 hashes are capped at HASH_CONCURRENCY (4); the pool is larger so DNS, fs and crypto are never starved.
ENV UV_THREADPOOL_SIZE=8
# The global npm/pnpm are not needed to run migrations or the seed.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pn /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/pnx /opt/pnpm /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# Alpine runtime: a much smaller OS package set than the bookworm-slim base, hence far fewer scanner findings
# (perl-base, util-linux, ncurses, zlib are not present).
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production
# argon2 runs on the libuv pool; HASH_CONCURRENCY (default 4) + 4 spare threads for DNS/fs/crypto.
# Keep >= HASH_CONCURRENCY + 4; guarded by backend/src/dockerfile.spec.ts.
ENV UV_THREADPOOL_SIZE=8
WORKDIR /app
# No package manager at runtime: smaller attack surface and fewer scanner findings.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Files stay root-owned; the process runs as "node", so it cannot rewrite its own code or dependencies.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# Liveness only (no database call), so a slow database never gets a healthy API container killed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/'+(process.env.API_PREFIX||'api/v1')+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

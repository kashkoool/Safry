# syntax=docker/dockerfile:1
# Static SPA served by unprivileged nginx (listens on 8080, runs as uid 101).
# Base images are pinned by tag AND digest; Dependabot ("docker" ecosystem) bumps both together.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
COPY tools/pnpm/package.json tools/pnpm/package-lock.json /opt/pnpm/
RUN npm ci --ignore-scripts --prefix /opt/pnpm && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083
# tiff, libexpat and libx11 are upgraded explicitly: the pinned base image still ships versions with fixed HIGH advisories. Drop this when the base image is rebuilt.
USER root
RUN apk upgrade --no-cache tiff libexpat libx11
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/ /etc/nginx/snippets/
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

# syntax=docker/dockerfile:1
# Static SPA served by unprivileged nginx (listens on 8080, runs as uid 101).
# Base images are pinned by tag AND digest; Dependabot ("docker" ecosystem) bumps both together.
FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
RUN npm install -g --ignore-scripts pnpm@11.28.5 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083
# tiff is upgraded explicitly: the pinned base image still ships a version with a fixed HIGH advisory. Drop this when the base image is rebuilt.
USER root
RUN apk upgrade --no-cache tiff
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/ /etc/nginx/snippets/
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

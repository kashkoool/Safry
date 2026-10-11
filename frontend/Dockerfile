# syntax=docker/dockerfile:1
# Static SPA served by unprivileged nginx (listens on 8080, runs as uid 101).
# Base images are pinned by tag AND digest; Dependabot ("docker" ecosystem) bumps both together.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
RUN npm install -g --ignore-scripts pnpm@11.28.5 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/ /etc/nginx/snippets/
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

# syntax=docker/dockerfile:1.7

FROM node:25-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p node_modules

FROM rclone/rclone:latest AS rclone-bin

FROM node:25-bookworm-slim AS app-files
ARG APP_UID=10001
ARG APP_GID=10001
WORKDIR /app
RUN mkdir -p /app /data /state && chown -R "${APP_UID}:${APP_GID}" /app /data /state
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config
COPY public ./public
COPY README.md ./
COPY theme.css variables.css tokens.json ./
RUN chown -R "${APP_UID}:${APP_GID}" /app

FROM gcr.io/distroless/nodejs22-debian12
ARG APP_UID=10001
ARG APP_GID=10001
WORKDIR /app
ENV NODE_ENV=production \
    SYNC_LOCAL_PATH=/data \
    STATE_DIR=/state \
    API_HOST=0.0.0.0 \
    API_PORT=8080 \
    RCLONE_BINARY=/usr/local/bin/rclone \
    RCLONE_CONFIG=/config/rclone/rclone.conf
COPY --from=app-files --chown=${APP_UID}:${APP_GID} /app /app
COPY --from=app-files --chown=${APP_UID}:${APP_GID} /data /data
COPY --from=app-files --chown=${APP_UID}:${APP_GID} /state /state
COPY --from=rclone-bin /usr/local/bin/rclone /usr/local/bin/rclone
USER ${APP_UID}:${APP_GID}
VOLUME ["/data", "/state", "/config/rclone"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/nodejs/bin/node", "/app/src/healthcheck.js"]
CMD ["/app/src/index.js"]

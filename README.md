# DockSync

[![CI](https://github.com/BunnySweety/DockSync/actions/workflows/ci.yml/badge.svg)](https://github.com/BunnySweety/DockSync/actions/workflows/ci.yml)

DockSync is a rootless container service that synchronizes a mounted local path with Proton Drive. It delegates Proton authentication and file transfer to an existing Rclone remote.

## Quick Start

```bash
npm ci
npm run onboard
npm run check
npm test
```

`npm run onboard` creates ignored runtime directories and runs a deployment preflight. See `DEPLOYMENT.md` for the full host setup, Proton Drive Rclone configuration, hardened Docker run command, and rollback notes.

## Features

- Bidirectional incremental sync using a persisted state file in `/state`.
- Conflict handling with `newer-wins`, `local-wins`, or `remote-wins`; overwritten content is preserved as `*.conflict-*`.
- JSON structured logs, retry with exponential backoff, graceful `SIGTERM` shutdown, and optional error webhook notifications.
- Web console at `GET /`, health/status endpoints at `GET /healthz` and `GET /status`, and manual trigger at `POST /sync`.
- Rootless distroless Docker runtime with read-only root filesystem support.
- Rclone backend for Proton Drive using a mounted `rclone.conf`.
- Frontend styling uses the design tokens from `DESIGN.md`, `theme.css`, `variables.css`, and `tokens.json`.

## Proton Drive via Rclone

Configure Proton Drive with Rclone on the host:

```bash
rclone config
rclone lsd proton:
```

Then copy or bind the config into this project:

```bash
mkdir -p data state rclone
cp ~/.config/rclone/rclone.conf rclone/rclone.conf
chmod 600 rclone/rclone.conf
```

Run DockSync with the Rclone backend:

```bash
docker run --rm --read-only --user 10001:10001 \
  -e SYNC_BACKEND=rclone \
  -e RCLONE_REMOTE=proton: \
  -e SYNC_REMOTE_PATH=/DockSync \
  --mount "type=bind,source=$PWD/data,target=/data" \
  --mount "type=bind,source=$PWD/state,target=/state" \
  --mount "type=bind,source=$PWD/rclone,target=/config/rclone,readonly" \
  docksync:local
```

If the Rclone config is encrypted, create `secrets/rclone_config_pass` and set `RCLONE_CONFIG_PASS_FILE=/run/secrets/rclone_config_pass`.

## Build and Run

```bash
npm install
npm run doctor
npm start
```

`npm start` expects a configured Rclone remote. For local development without Proton Drive, use the local Rclone remote example below.

Run a single local sync with a local Rclone remote:

```bash
mkdir -p data state/local-remote rclone
: > rclone/rclone.conf
SYNC_BACKEND=rclone \
  SYNC_LOCAL_PATH="$PWD/data" \
  STATE_DIR="$PWD/state" \
  RCLONE_BINARY=rclone \
  RCLONE_REMOTE=":local:$PWD/state/local-remote" \
  RCLONE_CONFIG="$PWD/rclone/rclone.conf" \
  SYNC_ONCE=true \
  npm start
```

Build and run the container:

```bash
docker build -t docksync:local .
mkdir -p data state rclone
docker run --rm --read-only --user 10001:10001 \
  --mount "type=bind,source=$PWD/data,target=/data" \
  --mount "type=bind,source=$PWD/state,target=/state" \
  --mount "type=bind,source=$PWD/rclone,target=/config/rclone,readonly" \
  --env-file config/docksync.env.example \
  docksync:local
```

Or use Compose:

```bash
docker compose up --build
```

`npm run onboard` creates empty ignored secret placeholders. To mount encrypted Rclone config or webhook URL secrets through Compose, fill the needed files under `secrets/` and include the override:

```bash
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up --build -d
```

Open `http://localhost:8080/` to follow the onboarding checklist, view status, inspect recent sync activity, and trigger a manual sync when `ENABLE_REST_API=true`.

## Configuration

All runtime configuration is environment-driven. See `config/docksync.env.example` for defaults. Important values include `SYNC_BACKEND`, `SYNC_LOCAL_PATH`, `SYNC_REMOTE_PATH`, `SYNC_INTERVAL_SECONDS`, `CONFLICT_STRATEGY`, `BANDWIDTH_LIMIT_BYTES_PER_SECOND`, `RCLONE_REMOTE`, `RCLONE_CONFIG`, and `ERROR_WEBHOOK_URL_FILE`.

Keep runtime data out of the repository. The ignored local directories are:

- `data/` for the synchronized local tree.
- `state/` for DockSync state, cache, and temporary files.
- `rclone/` for mounted Rclone configuration.
- `secrets/` for local secret files.
- `docker-test/` for release-check scratch data.

## Testing

Run the local test suite:

```bash
npm test
```

The suite checks the frontend theme contract, Rclone-backed sync behavior, conflict preservation, frontend asset serving, status/health APIs, and manual sync flow with a temporary local Rclone-compatible fixture.

Run the first-release gate before publishing an image:

```bash
npm run release:check
```

This builds the Docker image, runs it with a read-only root filesystem, rootless user, dropped capabilities, and a local Rclone remote, then verifies the web console assets, status APIs, health check, manual sync, and file transfer results.

## Deployment

Use `DEPLOYMENT.md` for a step-by-step deployment checklist. The frontend also exposes the same host commands and readiness checks at `GET /onboarding`. At minimum, configure the Proton Drive remote with Rclone, keep `rclone/rclone.conf` and secrets outside Git, run `npm run release:check`, then deploy with Compose.

## Security Notes

Run with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, and writable mounts only for `/data` and `/state`. Keep credentials outside the image, rotate session material regularly, and isolate the container network to the minimum egress required for Proton Drive.

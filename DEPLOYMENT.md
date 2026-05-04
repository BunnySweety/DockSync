# Deployment Guide

This guide takes a fresh DockSync checkout to a hardened local container deployment.

## 1. Host Prerequisites

Install these on the host:

- Node.js 22 or newer for local checks.
- Docker Engine or Docker Desktop.
- Rclone only if you choose the manual host-side Proton setup fallback.

Run the preflight:

```bash
npm ci
npm run onboard
```

`npm run onboard` creates ignored `data/`, `state/`, `rclone/`, and `secrets/` paths, including empty secret placeholders for the optional Compose override. It then verifies local prerequisites and package hygiene.

## 2. Prepare Runtime Paths

`npm run onboard` creates the writable host paths used by the container. Leave `rclone/rclone.conf` absent for first-run UI onboarding; the web assistant can create it after Compose starts.

Optional secret placeholders are created under `secrets/`. Leave unused placeholders empty; Docker mounts them through the optional Compose secrets override.

For webhook notifications, store the webhook URL outside Git:

```bash
printf '%s\n' 'https://example.invalid/webhook' > secrets/docksync_error_webhook
chmod 600 secrets/docksync_error_webhook
```

## 3. Optional Manual Proton Drive Fallback

The recommended deployment path configures Proton Drive from the web assistant. Use this fallback only if you already manage Rclone on the host:

```bash
rclone config
rclone lsd proton:
```

Copy the generated Rclone config into DockSync:

```bash
cp ~/.config/rclone/rclone.conf rclone/rclone.conf
chmod 600 rclone/rclone.conf
```

If the Rclone config is encrypted, store the passphrase outside Git:

```bash
printf '%s\n' 'your-rclone-config-passphrase' > secrets/rclone_config_pass
chmod 600 secrets/rclone_config_pass
```

## 4. Validate Locally

Run the full local gate before deploying:

```bash
npm run check
npm test
npm run release:check
```

For a no-Proton smoke test, use the local Rclone remote example in `README.md`.

## 5. Build and Run

Build the image:

```bash
docker build -t docksync:local .
```

Run with Compose:

```bash
docker compose up --build -d
```

Compose binds the web console to `127.0.0.1:8080` and mounts `rclone/` writable so the installation assistant can create `rclone/rclone.conf`.

To mount secret files through Compose, include the secrets override:

```bash
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up --build -d
```

Or run directly:

```bash
docker run -d --name docksync \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:noexec,nosuid,nodev,size=64m \
  -p 127.0.0.1:8080:8080 \
  --env-file config/docksync.env.example \
  --mount "type=bind,source=$PWD/data,target=/data" \
  --mount "type=bind,source=$PWD/state,target=/state" \
  --mount "type=bind,source=$PWD/rclone,target=/config/rclone" \
  docksync:local
```

For direct `docker run` with an encrypted Rclone config, add:

```bash
--env RCLONE_CONFIG_PASS_FILE=/run/secrets/rclone_config_pass \
--mount "type=bind,source=$PWD/secrets/rclone_config_pass,target=/run/secrets/rclone_config_pass,readonly"
```

Open `http://127.0.0.1:8080/` for the web console.
Use the first-connection installation assistant to enter Proton account details, import an existing `rclone.conf`, confirm runtime mounts, verify optional secrets, and check the manual sync API from the running container.
The console remains available if `rclone/rclone.conf` is missing, but synchronization will report setup action items until the Proton remote is mounted.

## 6. Operations

- Check health: `curl -fsS http://127.0.0.1:8080/healthz`.
- View logs: `docker logs docksync`.
- Trigger manual sync: `curl -fsS -X POST http://127.0.0.1:8080/sync`.
- Backup `state/` before upgrades if you need to preserve sync history.
- Keep `data/`, `state/`, `rclone/`, and `secrets/` out of Git.

## 7. Upgrade and Rollback

Run `git pull`, `npm ci`, and `npm run release:check`, then rebuild the image. Keep the previous image tag until the new container has completed a successful sync. To roll back, stop the new container and run the previous image with the same `data/`, `state/`, and `rclone/` mounts.

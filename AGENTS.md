# Repository Guidelines

## Project Structure & Module Organization

DockSync is a Node.js sync service packaged as a rootless distroless Docker image. Proton Drive uses Rclone only.

- `src/` contains the runtime service, sync engine, HTTP/API server, local file helpers, and backend adapter wiring.
- `public/` contains the dependency-free web console served from `GET /`; `index.html` loads `variables.css` before `styles.css`, and UI should align with `DESIGN.md`, `theme.css`, and `tokens.json`.
- `src/backends/rclone-remote.js` is the only remote backend.
- `config/docksync.env.example` documents runtime environment variables.
- `DEPLOYMENT.md` is the deployment checklist; `DESIGN.md`, `tokens.json`, `variables.css`, and `theme.css` are design assets.
- Runtime-only folders such as `data/`, `state/`, `secrets/`, `rclone/`, and `docker-test/` must stay out of commits.

## Build, Test, and Development Commands

- `npm ci` validates the lockfile and prepares the local Node workspace.
- `npm run onboard` creates ignored runtime directories and runs deployment preflight.
- `npm start` runs the service with environment configuration.
- `SYNC_BACKEND=rclone SYNC_ONCE=true npm start` runs a one-shot sync using the configured Rclone remote.
- `npm run check` syntax-checks JavaScript under `src/` and `public/`.
- `npm test` runs the frontend theme contract, sandbox sync, and frontend e2e tests.
- `npm run release:check` builds and smoke-tests the hardened Docker image.
- `docker compose up --build` builds and runs the Rclone-enabled container.

Use `python3 -m json.tool tokens.json >/dev/null` when editing tokens. Keep `data/`, `state/`, `rclone/`, `secrets/`, and `docker-test/` local.

## Coding Style & Naming Conventions

Use ES modules and two-space indentation for JavaScript, JSON, and CSS. Prefer explicit imports from `node:*` built-ins. Environment variables use uppercase snake case, for example `SYNC_LOCAL_PATH`, `SYNC_BACKEND`, and `RCLONE_REMOTE`. Token names stay lowercase and hyphenated, for example `privacy-violet`.

## Testing Guidelines

`npm test` runs the Rclone backend against a temporary local fixture and verifies the frontend asset/API path. Run `npm run release:check` before release-oriented changes. Keep Proton Drive tests isolated from real credentials unless they use explicit Docker secrets or a disposable test remote.

## Commit & Pull Request Guidelines

Git history was unavailable in this environment, so use concise imperative commit messages such as `Tighten rclone path handling` or `Document Proton setup`. Pull requests should explain what changed, list affected files, and include validation performed. Include screenshots for design changes.

## Agent-Specific Instructions

Keep edits small and verify `npm test` after service changes. Do not commit credentials, Rclone configs, state directories, data, or `node_modules`. Store Proton/Rclone secrets in Docker secrets or another external secret manager.

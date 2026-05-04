import { RcloneRemoteBackend } from './rclone-remote.js';

export async function createRemoteBackend(config, logger) {
  const backend = {
    rclone: () => new RcloneRemoteBackend(config, logger),
  }[config.backend]();
  await backend.init();
  return backend;
}

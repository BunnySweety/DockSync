import { errorToFields } from './logger.js';

export async function notifyError(config, logger, error, context = {}) {
  if (!config.notificationWebhookUrl) {
    return;
  }

  try {
    const response = await fetch(config.notificationWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'docksync_error',
        ts: new Date().toISOString(),
        ...context,
        ...errorToFields(error),
      }),
    });
    if (!response.ok) {
      logger.warn('error_notification_failed', { status: response.status });
    }
  } catch (notificationError) {
    logger.warn('error_notification_failed', errorToFields(notificationError));
  }
}

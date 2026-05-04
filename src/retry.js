export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}

export async function withRetry(operation, config, logger, signal) {
  let delay = config.retry.initialDelayMs;
  let attempt = 1;
  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= config.retry.maxAttempts || signal?.aborted) {
        throw error;
      }
      logger.warn('retry_scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        delayMs: delay,
        error: error.message,
      });
      await sleep(delay, signal);
      delay = Math.min(delay * 2, config.retry.maxDelayMs);
      attempt += 1;
    }
  }
}

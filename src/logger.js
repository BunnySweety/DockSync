export class Logger {
  log(level, message, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...fields,
    };
    console.log(JSON.stringify(entry));
  }

  debug(message, fields) {
    this.log('debug', message, fields);
  }

  info(message, fields) {
    this.log('info', message, fields);
  }

  warn(message, fields) {
    this.log('warn', message, fields);
  }

  error(message, fields) {
    this.log('error', message, fields);
  }
}

export function errorToFields(error) {
  return {
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack,
    },
  };
}

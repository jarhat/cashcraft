export function createLogger(level, sink = console) {
  if (!['off', 'error', 'debug'].includes(level)) {
    throw new Error('VITE_CONSOLE_LOG_LEVEL must be off, error, or debug.');
  }

  return {
    info: (...args) => { if (level === 'debug') sink.info(...args); },
    warn: (...args) => { if (level !== 'off') sink.warn(...args); },
    error: (...args) => { if (level !== 'off') sink.error(...args); },
  };
}

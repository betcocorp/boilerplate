/**
 * Minimal structured logger: `logInfo('event_name', { ...fields })`. Swap the console calls for
 * your real sink (Sentry breadcrumbs, a log-drain client, etc.) — this scaffold just gives call
 * sites a stable shape to log against.
 */
type Fields = Record<string, unknown>;

function log(level: 'info' | 'warn' | 'error', event: string, fields?: Fields): void {
  const line = { level, event, ...fields, timestamp: new Date().toISOString() };
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(JSON.stringify(line));
}

export function logInfo(event: string, fields?: Fields): void {
  log('info', event, fields);
}

export function logWarn(event: string, fields?: Fields): void {
  log('warn', event, fields);
}

export function logError(event: string, fields?: Fields): void {
  log('error', event, fields);
}

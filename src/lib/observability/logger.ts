export type LogFields = Record<string, unknown>;

function basePayload(level: string, event: string, fields: LogFields) {
  return {
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
}

export function logInfo(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify(basePayload('info', event, fields)));
}

export function logWarn(event: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify(basePayload('warn', event, fields)));
}

export function logError(event: string, fields: LogFields = {}): void {
  console.error(JSON.stringify(basePayload('error', event, fields)));
}

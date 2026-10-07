import { randomUUID } from 'crypto';

export function newCorrelationId(): string {
  return randomUUID();
}

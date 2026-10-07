import { describe, expect, it } from 'vitest';

import { formatMappingTimestamp } from './cross-reference-mappings';

describe('formatMappingTimestamp — legacy naive wall-clock stamps', () => {
  it('renders the ISO-style `T` separator form as YYYY-MM-DD HH:MM', () => {
    expect(formatMappingTimestamp('2026-01-15T13:04:00')).toBe('2026-01-15 13:04');
  });

  it('renders the space-separated PostgREST form as YYYY-MM-DD HH:MM', () => {
    expect(formatMappingTimestamp('2011-04-26 14:30:00')).toBe('2011-04-26 14:30');
  });

  it('drops fractional seconds', () => {
    expect(formatMappingTimestamp('2026-01-15T13:04:00.123456')).toBe('2026-01-15 13:04');
  });

  it('renders the stored wall-clock time verbatim, without timezone conversion', () => {
    // A late-evening stamp must not roll into the next day under any server timezone.
    expect(formatMappingTimestamp('2019-12-31 23:59:59')).toBe('2019-12-31 23:59');
  });

  it('falls back to an em dash for null', () => {
    expect(formatMappingTimestamp(null)).toBe('—');
  });

  it('falls back to an em dash for undefined', () => {
    expect(formatMappingTimestamp(undefined)).toBe('—');
  });

  it('falls back to an em dash for an empty string', () => {
    expect(formatMappingTimestamp('')).toBe('—');
  });

  it('falls back to an em dash for an unparseable string', () => {
    expect(formatMappingTimestamp('not a timestamp')).toBe('—');
  });
});

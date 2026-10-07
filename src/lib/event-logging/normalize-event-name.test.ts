import { describe, expect, it } from 'vitest';

import {
  PAGE_VIEW_EVENT_PREFIX,
  normalizeAnalyticsEventName,
} from '~/lib/event-logging/normalize-event-name';

describe('normalizeAnalyticsEventName', () => {
  it('prefixes a bare event name with "analytics."', () => {
    expect(normalizeAnalyticsEventName('bex.chat.message.sent')).toBe(
      'analytics.bex.chat.message.sent',
    );
  });

  it('leaves an already-prefixed name unchanged', () => {
    expect(normalizeAnalyticsEventName('analytics.search.submit')).toBe(
      'analytics.search.submit',
    );
  });

  it('leaves page-view names under the shared prefix unchanged', () => {
    const name = `${PAGE_VIEW_EVENT_PREFIX}.bex.chat`;
    expect(normalizeAnalyticsEventName(name)).toBe(name);
    expect(PAGE_VIEW_EVENT_PREFIX).toBe('analytics.page.view');
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeAnalyticsEventName('  bex.chat  ')).toBe('analytics.bex.chat');
    expect(normalizeAnalyticsEventName('  analytics.bex.chat  ')).toBe(
      'analytics.bex.chat',
    );
  });

  it('returns an empty string for empty or whitespace-only input (never bare "analytics.")', () => {
    expect(normalizeAnalyticsEventName('')).toBe('');
    expect(normalizeAnalyticsEventName('   ')).toBe('');
    expect(normalizeAnalyticsEventName('\n\t')).toBe('');
  });

  it('does not treat a name merely containing "analytics." as prefixed', () => {
    expect(normalizeAnalyticsEventName('bex.analytics.thing')).toBe(
      'analytics.bex.analytics.thing',
    );
  });
});

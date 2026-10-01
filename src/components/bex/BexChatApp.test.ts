import { describe, expect, it } from 'vitest';

import { isBexRequestFailedEvent } from '~/components/bex/BexChatApp';

/**
 * B0-693 (part 2) — regression coverage for the event-shape detection `sendUserText` relies on to
 * surface a mid-stream/pre-stream workflow failure instead of silently hanging. There is no
 * existing test harness for mounting `BexChatApp` itself (it pulls in the permissions store,
 * `next/navigation`'s `useSearchParams`, and several API-client modules with no existing mock
 * setup), so this file exercises the exported pure predicate directly; `bex-api-client.test.ts`
 * covers the SSE-to-`onEvent` plumbing this predicate is applied to.
 */
describe('isBexRequestFailedEvent', () => {
  it('matches the exact shape the route emits on a failed run', () => {
    expect(
      isBexRequestFailedEvent({ type: 'status', stage: 'request_failed', error: 'boom' }),
    ).toBe(true);
  });

  it('matches even without an error field (defensive)', () => {
    expect(isBexRequestFailedEvent({ type: 'status', stage: 'request_failed' })).toBe(true);
  });

  it('does not match other status stages', () => {
    expect(isBexRequestFailedEvent({ type: 'status', stage: 'agent_started' })).toBe(false);
    expect(isBexRequestFailedEvent({ type: 'status', stage: 'workflow_completed' })).toBe(false);
  });

  it('does not match a non-status event type', () => {
    expect(
      isBexRequestFailedEvent({ type: 'tool', phase: 'started', name: 'search_product_docs' }),
    ).toBe(false);
  });

  it('does not match null, undefined, primitives, or arrays', () => {
    expect(isBexRequestFailedEvent(null)).toBe(false);
    expect(isBexRequestFailedEvent(undefined)).toBe(false);
    expect(isBexRequestFailedEvent('request_failed')).toBe(false);
    expect(isBexRequestFailedEvent(['status', 'request_failed'])).toBe(false);
  });
});

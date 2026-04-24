import { describe, expect, it } from 'vitest';

import { POST } from '~/app/api/bex/chat/route';

describe('POST /api/bex/chat (deprecated)', () => {
  it('returns 410 with migration guidance', async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body).toEqual({
      error: 'Legacy chat endpoint is permanently deprecated. Use /api/bex/chat/stream.',
    });
  });
});

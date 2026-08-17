import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('GET /api/v1/health', () => {
  it('reports ok and touches the real D1 binding', async () => {
    // `new Request()` infers the looser outgoing-fetch Cf property type;
    // an incoming Worker request carries the richer IncomingRequestCfProperties.
    // The cast bridges that — a test-only concern, not a production one.
    const request = new Request('http://example.com/api/v1/health') as Request<
      unknown,
      IncomingRequestCfProperties
    >;
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok' });
  });
});

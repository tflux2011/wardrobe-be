import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { createRateLimiter } from '../src/middleware/rate_limit';

test('changing forwarded headers cannot bypass the request cap', async () => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60000, maxRequests: 1 }));
  app.get('/', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 200);
    const denied = await fetch(url, { headers: { 'X-Forwarded-For': '2.2.2.2' } });
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

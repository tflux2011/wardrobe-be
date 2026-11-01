import {fakeUsage} from './usage_fixture';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { prisma } from '../src/lib/prisma';
import { adminRouter } from '../src/routes/admin';

// Prisma delegates are proxies, so replace their methods directly rather than
// relying on property descriptors in node:test's mock.method.
function stub(t: TestContext, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name];
  const mock = t.mock.fn(implementation);
  target[name] = mock;
  t.after(() => { target[name] = original; });
  return mock;
}

async function serve(app: express.Express, run: (url: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

function appFor(router: express.Router) {
  const app = express();
  app.use(express.json(), router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

test('admin login requires configured credentials; diagnostics requires a valid session', async t => {
  fakeUsage(t);
  const originalUsername = process.env.ADMIN_USERNAME;
  const originalPassword = process.env.ADMIN_PASSWORD;
  t.after(() => {
    if (originalUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
  });
  await serve(appFor(adminRouter), async url => {
    const login = (username: string, password: string) => fetch(`${url}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    assert.equal((await login('admin', 'wardrobe2024')).status, 503);
    process.env.ADMIN_USERNAME = 'test-admin';
    process.env.ADMIN_PASSWORD = '   ';
    assert.equal((await login('test-admin', '   ')).status, 503);
    process.env.ADMIN_PASSWORD = 'test-password';
    assert.equal((await login('admin', 'wardrobe2024')).status, 401);
    assert.equal((await fetch(`${url}/test-supabase`)).status, 401);
    assert.equal((await fetch(`${url}/test-supabase`, {
      headers: { Authorization: 'Bearer invalid' },
    })).status, 403);
    const response = await login('test-admin', 'test-password');
    assert.equal(response.status, 200);
    const { token } = await response.json() as { token: string };
    stub(t, prisma.user, 'count', async () => 1);
    stub(t, prisma.clothingItem, 'count', async () => 2);
    stub(t, prisma.outfit, 'count', async () => 3);
    stub(t, prisma.trip, 'count', async () => 4);
    const stats = await fetch(`${url}/stats`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stats.status, 200);
    assert.deepEqual(await stats.json(), { users: 1, items: 2, outfits: 3, trips: 4 });
    // Exercise diagnostics without making a storage request.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-never-send';
    const { supabase } = await import('../src/lib/supabase');
    t.mock.method(supabase.storage, 'from', () => ({
      upload: async () => ({ data: null, error: { message: 'mock storage failure' } }),
    }));
    const diagnostic = await fetch(`${url}/test-supabase`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(diagnostic.status, 200);
    const result = await diagnostic.json() as any;
    assert.deepEqual(result.diagnostics, { urlSet: true, keySet: true });
    assert.equal(result.stack, undefined);
    assert.equal(JSON.stringify(result).includes('test-key'), false);
  });
});

test('an empty wardrobe never reads or transfers clothing owned by another UID', async t => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const { wardrobeRouter } = await import('../src/routes/wardrobe');
  stub(t, prisma.user, 'findUnique', async () => ({ id: 'current', email: 'same@example.com' }));
  const findItems = stub(t, prisma.clothingItem, 'findMany', async () => []);
  const findUsers = stub(t, prisma.user, 'findMany', async () => {
    throw new Error('Must not search for other users by email');
  });
  const transfer = stub(t, prisma.clothingItem, 'updateMany', async () => {
    throw new Error('Must not transfer ownership');
  });
  const app = express();
  app.use((req, _res, next) => {
    req.user = { uid: 'current', email: 'same@example.com' };
    next();
  }, wardrobeRouter);
  await serve(app, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    assert.deepEqual(findItems.mock.calls[0].arguments, [{
      where: { userId: 'current' }, orderBy: { addedAt: 'desc' },
    }]);
    assert.equal(findUsers.mock.callCount(), 0);
    assert.equal(transfer.mock.callCount(), 0);
  });
});

test('offline item creation preserves addedAt but retries cannot change existing item age', async t => {
  fakeUsage(t);
  stub(t,prisma.clothingItem,'count',async()=>0);
  stub(t,prisma.clothingItem,'findFirst',async()=>({id:'owned'}));
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const { wardrobeRouter } = await import('../src/routes/wardrobe');
  stub(t, prisma.user, 'findUnique', async () => ({ id: 'current', email: 'me@example.com' }));
  let existing: any = null;
  stub(t, prisma.clothingItem, 'findUnique', async () => existing);
  const create = stub(t, prisma.clothingItem, 'create', async ({ data }) => ({ ...data }));
  const update = stub(t, prisma.clothingItem, 'update', async ({ data }) => ({ ...existing, ...data }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { uid: 'current', email: 'me@example.com' };
    next();
  }, wardrobeRouter);
  const item = {
    id: 'offline-item', name: 'Shirt', category: 'top', style: 'casual',
    colors: ['blue'], occasions: [], seasons: [], tags: [],
    imageUrl: 'https://example.com/shirt.png',
    addedAt: '2024-06-01T12:00:00.000Z',
  };
  await serve(app, async url => {
    const post = (body: object) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post({ ...item, addedAt: 'invalid' })).status, 400);
    assert.equal(create.mock.callCount(), 0);
    assert.equal((await post(item)).status, 200);
    const created = create.mock.calls[0].arguments[0].data;
    assert.equal(created.userId, 'current');
    assert.equal(created.addedAt.toISOString(), item.addedAt);
    existing = created;
    assert.equal((await post({ ...item, addedAt: '2025-01-01T00:00:00.000Z' })).status, 200);
    assert.equal('addedAt' in update.mock.calls[0].arguments[0].data, false);
  });
});

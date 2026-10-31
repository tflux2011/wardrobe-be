import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateReferencedOutfit, referenceImage } from '../src/services/outfit_image_service';

test('front receives every photograph; back uses front plus identical references', async () => {
  const calls: { prompt: string; images: string[] }[] = [];
  const garments = [
    { id: 'shirt', name: 'Blue linen shirt', category: 'top', imageUrl: 'https://storage.example/shirt.png' },
    { id: 'pants', name: 'Khaki cargo pants', category: 'bottom', imageUrl: 'https://storage.example/pants.png' },
  ];
  const result = await generateReferencedOutfit(garments, 'minimal', 'masculine', async (prompt, images) => {
    calls.push({ prompt, images });
    return calls.length === 1 ? 'front-bytes' : 'back-bytes';
  });
  assert.deepEqual(calls[0].images, garments.map(g => g.imageUrl));
  assert.deepEqual(calls[1].images, ['data:image/png;base64,front-bytes', ...calls[0].images]);
  assert.match(calls[1].prompt, /SAME dressed mannequin/);
  assert.deepEqual(result.referenceItemIds, ['shirt', 'pants']);
});

test('unusable references fail before any image call instead of text-only fallback', async () => {
  let called = false;
  await assert.rejects(generateReferencedOutfit([{ id: 'shirt', name: 'Shirt', category: 'top', imageUrl: '' }], '', '', async () => { called = true; return 'bad'; }));
  assert.equal(called, false);
  await assert.rejects(referenceImage('/uploads/../../.env'));
  await assert.rejects(generateReferencedOutfit([], '', ''));
});

import express from 'express';
import { once } from 'node:events';
import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { imagesRouter } from '../src/routes/images';

test('route loads only owned records and returns confirmed photo references', async t => {
  const originalFind = prisma.clothingItem.findMany;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
  const originalPost = axios.post;
  const calls: any[] = [];
  axios.post = (async (url: string, data: any) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    calls.push(data);
    return { data: { data: [{ b64_json: 'dGVzdA==' }] } };
  }) as any;
  let available = true;
  prisma.clothingItem.findMany = (async (args: any) => {
    assert.deepEqual(args.where, { userId: 'signed-in-user', id: { in: ['shirt'] } });
    return available ? [{ id: 'shirt', name: 'My actual shirt', category: 'top', imageUrl: 'https://storage.example/actual-shirt.png' }] : [];
  }) as any;
  t.after(() => {
    prisma.clothingItem.findMany = originalFind;
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { uid: 'signed-in-user' } as any; next(); });
  app.use(imagesRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/outfit/reference`;
  const request = (view?: 'front' | 'back', frontPreviewId?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view, frontPreviewId, prompt: 'An outfit preview', wardrobeContext: [{ id: 'shirt', imageUrl: 'https://untrusted.example/wrong-shirt.png' }] }) });
  try {
    const response = await request();
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.generationVersion, 'photo-references-v2');
    assert.deepEqual(data.referenceItemIds, ['shirt']);
    assert.deepEqual(calls[0].images, [{ image_url: 'https://storage.example/actual-shirt.png' }]);
    assert.equal(calls[1].images[0].image_url, 'data:image/png;base64,dGVzdA==');
    for (const view of ['front', 'back']) await fs.unlink(path.join(__dirname, '..', data[view].imageUrl));
    const first = await (await request('front')).json() as any;
    assert.equal(calls.length, 3);
    assert.equal(first.front.imageBase64, undefined);
    assert.equal(first.back, undefined);
    const cached = await (await request('front')).json() as any;
    assert.equal(cached.front.imageUrl, first.front.imageUrl);
    assert.equal(calls.length, 3);
    const back = await (await request('back', first.previewId)).json() as any;
    assert.equal(calls.length, 4);
    assert.equal(calls[3].images[0].image_url, 'data:image/png;base64,dGVzdA==');
    for (const view of [first.front, back.back]) await fs.unlink(path.join(__dirname, '..', view.imageUrl));
    available = false;
    assert.equal((await request('front')).status, 422);
    assert.equal(calls.length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

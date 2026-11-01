import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { fakeUsage } from "./usage_fixture";
import { clothingRouter } from "../src/routes/clothing";
import { prisma } from "../src/lib/prisma";
import { savePrivatePhoto, ownedPhoto } from "../src/services/media";

test("a renamed non-image is rejected before AI or storage is used", async (t) => {
  const store = fakeUsage(t);
  store.stub(prisma.clothingItem, "count", async () => 0);
  const app = express();
  app.use((req, _res, next) => {
    req.user = { uid: "alice", email: null };
    next();
  });
  app.use(clothingRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const form = new FormData();
    form.append(
      "image",
      new Blob(["This is not an image"], { type: "image/jpeg" }),
      "fake.jpg",
    );
    const result = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/upload`,
      { method: "POST", body: form },
    );
    assert.equal(result.status, 400);
    assert.match(((await result.json()) as any).error, /valid JPEG or PNG/);
    assert.equal(store.assets.size, 0);
    assert.equal(
      [...store.counters.values()].find(
        (c) => c.userId === "alice" && c.feature === "uploads",
      )?.used,
      1,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("a storage cap rejects before uploading bytes and another UID cannot reuse a private photo", async (t) => {
  const store = fakeUsage(t);
  const previous = process.env.BETA_STORAGE_BYTES;
  process.env.BETA_STORAGE_BYTES = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.BETA_STORAGE_BYTES;
    else process.env.BETA_STORAGE_BYTES = previous;
  });
  await assert.rejects(savePrivatePhoto(Buffer.from("too big"), "alice"), {
    statusCode: 429,
  });
  assert.equal(store.assets.size, 0);
  const id = "d5f5ba71-e329-4e1e-bb32-148c5b3c7777";
  store.assets.set(id, { id, userId: "alice", ready: true });
  store.stub(prisma.clothingItem, "findFirst", async () => null);
  assert.equal(
    await ownedPhoto(`/media/${id}?ignored=token`, "alice"),
    `/media/${id}`,
  );
  await assert.rejects(ownedPhoto(`/media/${id}`, "bob"), { statusCode: 400 });
});

import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { prisma } from "../lib/prisma";
import { reserve, settle } from "../services/usage";
import { wardrobeRouter } from "../routes/wardrobe";

async function main() {
  const uid = `security-check-${randomUUID()}`;
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await prisma.user.create({ data: { id: uid } });
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        reserve(uid, "views", 1, `race-${i}`),
      ),
    );
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 5);
    const op = (
      attempts.find(
        (a) => a.status === "fulfilled",
      ) as PromiseFulfilledResult<string>
    ).value;
    await settle(op, false);
    await settle(op, false);
    await reserve(uid, "views", 1, "after-refund");
    await assert.rejects(reserve(uid, "views", 1, "over-cap"), {
      statusCode: 429,
    });
    const asset = await prisma.mediaAsset.create({
      data: {
        userId: uid,
        storagePath: `${uid}/verification-only`,
        bytes: 0,
        mimeType: "image/jpeg",
        ready: true,
      },
    });
    const item = {
      id: randomUUID(),
      name: "Security verification only",
      category: "top",
      style: "casual",
      colors: [],
      occasions: [],
      seasons: [],
      tags: [],
      imageUrl: `/media/${asset.id}`,
    };
    process.env.BETA_GARMENT_LIMIT = "1";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { uid, email: null };
      next();
    });
    app.use(wardrobeRouter);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const post = (data: any) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    const responses = await Promise.all([
      post(item),
      post({ ...item, id: randomUUID() }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
    const saved = await prisma.clothingItem.findFirstOrThrow({
      where: { userId: uid },
    });
    const edit = await post({
      ...item,
      id: saved.id,
      name: "Edited at the cap",
    });
    assert.equal(edit.status, 200);
    assert.equal(
      await prisma.clothingItem.count({ where: { userId: uid } }),
      1,
    );
    console.log(
      "PASS: PostgreSQL concurrent quota cap, one-time refund, concurrent garment cap, and editing at the cap.",
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
    await prisma.user.deleteMany({ where: { id: uid } });
    await prisma.mediaAsset.deleteMany({ where: { userId: uid } });
    await prisma.usageOperation.deleteMany({ where: { userId: uid } });
    await prisma.usageCounter.deleteMany({ where: { userId: uid } });
    await prisma.$disconnect();
  }
}
main().catch(() => {
  console.error(
    "Security database verification failed; inspect the release before deploying.",
  );
  process.exitCode = 1;
});

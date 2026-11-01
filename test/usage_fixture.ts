import type { TestContext } from "node:test";
import { prisma } from "../src/lib/prisma";
export function fakeUsage(t: TestContext) {
  const counters = new Map<string, any>(),
    ops = new Map<string, any>(),
    assets = new Map<string, any>();
  function stub(target: any, name: string, fn: any) {
    const original = target[name];
    target[name] = fn;
    t.after(() => {
      target[name] = original;
    });
  }
  let pending = Promise.resolve();
  stub(prisma, "$transaction", (fn: any) => {
    const result = pending.then(() => fn(prisma));
    pending = result.catch(() => undefined);
    return result;
  });
  stub(prisma, "$executeRaw", async () => 0);
  const key = (x: any) => JSON.stringify([x.userId, x.feature, x.period]);
  stub(prisma.usageCounter, "upsert", async ({ where, create }: any) => {
    const k = key(where.userId_feature_period);
    if (!counters.has(k)) counters.set(k, { ...create });
    return { ...counters.get(k) };
  });
  stub(prisma.usageCounter, "update", async ({ where, data }: any) => {
    const c = counters.get(key(where.userId_feature_period));
    c.used += (data.used.increment || 0) - (data.used.decrement || 0);
    return c;
  });
  stub(prisma.usageCounter, "findMany", async ({ where }: any) =>
    [...counters.values()].filter((c) => c.userId === where.userId),
  );
  stub(
    prisma.usageOperation,
    "findUnique",
    async ({ where }: any) => ops.get(where.id) ?? null,
  );
  stub(prisma.usageOperation, "findMany", async ({ where }: any) =>
    [...ops.values()].filter(
      (o) =>
        o.userId === where.userId &&
        o.state === where.state &&
        o.expiresAt <= where.expiresAt.lte,
    ),
  );
  stub(
    prisma.usageOperation,
    "upsert",
    async ({ where, create, update }: any) => {
      const value = ops.has(where.id)
        ? { ...ops.get(where.id), ...update }
        : { ...create };
      ops.set(where.id, value);
      return value;
    },
  );
  stub(prisma.usageOperation, "update", async ({ where, data }: any) => {
    Object.assign(ops.get(where.id), data);
    return ops.get(where.id);
  });
  stub(prisma.usageOperation, "updateMany", async ({ where, data }: any) => {
    const op = ops.get(where.id);
    if (!op || op.state !== where.state) return { count: 0 };
    Object.assign(op, data);
    return { count: 1 };
  });
  stub(prisma.mediaAsset, "aggregate", async ({ where }: any) => ({
    _sum: {
      bytes: [...assets.values()]
        .filter((a) => a.userId === where.userId)
        .reduce((s, a) => s + a.bytes, 0),
    },
  }));
  stub(prisma.mediaAsset, "create", async ({ data }: any) => {
    const asset = { ...data, ready: false };
    assets.set(data.id, asset);
    return asset;
  });
  stub(prisma.mediaAsset, "update", async ({ where, data }: any) => {
    Object.assign(assets.get(where.id), data);
    return assets.get(where.id);
  });
  stub(prisma.mediaAsset, "deleteMany", async ({ where }: any) => {
    assets.delete(where.id);
    return { count: 1 };
  });
  stub(
    prisma.mediaAsset,
    "findFirst",
    async ({ where }: any) =>
      [...assets.values()].find((a) =>
        Object.entries(where).every(([k, v]) => a[k] === v),
      ) ?? null,
  );
  return { counters, ops, assets, stub };
}

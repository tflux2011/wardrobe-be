import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import type { Prisma } from "@prisma/client";
import { ApiError } from "../utils/errors";

export type Feature = "uploads" | "views" | "trips" | "styling";
export function positiveSetting(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
export function allowance(feature: Feature) {
  return positiveSetting(
    `BETA_${feature.toUpperCase()}_LIMIT`,
    { uploads: 20, views: 5, trips: 3, styling: 30 }[feature],
  );
}
export const garmentLimit = () => positiveSetting("BETA_GARMENT_LIMIT", 100);
export const storageLimit = () =>
  positiveSetting("BETA_STORAGE_BYTES", 100 * 1024 * 1024);
export function periodFor(feature: Feature, now = new Date()) {
  return now
    .toISOString()
    .slice(0, feature === "uploads" || feature === "styling" ? 10 : 7);
}
export function resetFor(feature: Feature, now = new Date()) {
  return feature === "uploads" || feature === "styling"
    ? new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      )
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
export async function lockUser(tx: Prisma.TransactionClient, uid: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`clad:${uid}`}))`;
}
// A short DB transaction reserves capacity BEFORE any external work. No network calls hold the lock.
async function expire(tx: Prisma.TransactionClient, uid: string, now: Date) {
  const expired = await tx.usageOperation.findMany({
    where: { userId: uid, state: "pending", expiresAt: { lte: now } },
  });
  for (const op of expired) {
    await tx.usageCounter.update({
      where: {
        userId_feature_period: {
          userId: uid,
          feature: op.feature,
          period: op.period,
        },
      },
      data: { used: { decrement: op.amount } },
    });
    await tx.usageOperation.update({
      where: { id: op.id },
      data: { state: "expired" },
    });
  }
}
export async function reserve(
  uid: string,
  feature: Feature,
  amount = 1,
  operationKey: string = randomUUID(),
) {
  const now = new Date(),
    period = periodFor(feature, now);
  const id = createHash("sha256")
    .update(JSON.stringify([uid, feature, operationKey]))
    .digest("hex");
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, uid);
    await expire(tx, uid, now);
    const prior = await tx.usageOperation.findUnique({ where: { id } });
    if (prior && (prior.state === "pending" || prior.state === "done"))
      throw new ApiError(
        409,
        "This request was already submitted. Check your saved result before trying again.",
      );
    const key = { userId: uid, feature, period };
    const current = await tx.usageCounter.upsert({
      where: { userId_feature_period: key },
      create: { ...key, used: 0 },
      update: {},
    });
    if (current.used + amount > allowance(feature))
      throw new ApiError(
        429,
        `${feature === "views" ? "Your mannequin preview" : feature === "trips" ? "Your trip planning" : feature === "uploads" ? "Your photo upload" : "Your styling"} allowance is used up. It resets ${resetFor(feature, now).toISOString().slice(0, 10)} (UTC).`,
        {
          code: "ALLOWANCE_REACHED",
          feature,
          limit: allowance(feature),
          resetsAt: resetFor(feature, now).toISOString(),
        },
      );
    await tx.usageCounter.update({
      where: { userId_feature_period: key },
      data: { used: { increment: amount } },
    });
    await tx.usageOperation.upsert({
      where: { id },
      create: {
        id,
        ...key,
        amount,
        state: "pending",
        expiresAt: new Date(now.getTime() + 15 * 60000),
      },
      update: {
        period,
        amount,
        state: "pending",
        expiresAt: new Date(now.getTime() + 15 * 60000),
      },
    });
    return id;
  });
}
export async function settle(id: string, success: boolean) {
  const op = await prisma.usageOperation.findUnique({ where: { id } });
  if (!op) return;
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, op.userId);
    const changed = await tx.usageOperation.updateMany({
      where: { id, state: "pending" },
      data: { state: success ? "done" : "failed" },
    });
    if (changed.count && !success)
      await tx.usageCounter.update({
        where: {
          userId_feature_period: {
            userId: op.userId,
            feature: op.feature,
            period: op.period,
          },
        },
        data: { used: { decrement: op.amount } },
      });
  });
}
export async function reservePlatformBudget(
  feature: string,
  amount: number,
  limit: number,
) {
  const userId = `platform:${feature}`,
    period = new Date().toISOString().slice(0, 10);
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const row = await tx.usageCounter.upsert({
      where: { userId_feature_period: { userId, feature, period } },
      create: { userId, feature, period, used: 0 },
      update: {},
    });
    if (row.used + amount > limit)
      throw new ApiError(
        503,
        "Clad has reached today’s beta capacity for this feature. Your allowance has not been charged.",
      );
    await tx.usageCounter.update({
      where: { userId_feature_period: { userId, feature, period } },
      data: { used: { increment: amount } },
    });
  });
}
export const reserveImageBudget = (amount: number) =>
  reservePlatformBudget(
    "images",
    amount,
    positiveSetting("DAILY_PLATFORM_IMAGE_LIMIT", 200),
  );
export async function withAllowance<T>(
  uid: string,
  feature: Feature,
  run: () => Promise<T>,
  amount = 1,
  key?: string,
): Promise<T> {
  const id = await reserve(uid, feature, amount, key);
  try {
    if (feature === "views") await reserveImageBudget(amount);
    else
      await reservePlatformBudget(
        "text",
        1,
        positiveSetting("DAILY_PLATFORM_TEXT_LIMIT", 2000),
      );
    const value = await run();
    await settle(id, true);
    return value;
  } catch (error) {
    await settle(id, false);
    throw error;
  }
}
export async function usageSummary(uid: string) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, uid);
    await expire(tx, uid, new Date());
    const features: Feature[] = ["uploads", "views", "trips", "styling"];
    const counters = await tx.usageCounter.findMany({
      where: {
        userId: uid,
        period: { in: [periodFor("uploads"), periodFor("views")] },
      },
    });
    const saved = await tx.clothingItem.count({ where: { userId: uid } });
    const bytes =
      (
        await tx.mediaAsset.aggregate({
          where: { userId: uid },
          _sum: { bytes: true },
        })
      )._sum.bytes ?? 0;
    return {
      plan: "Free beta",
      garments: {
        used: saved,
        limit: garmentLimit(),
        remaining: Math.max(0, garmentLimit() - saved),
      },
      storage: { used: bytes, limit: storageLimit() },
      ...Object.fromEntries(
        features.map((feature) => {
          const used =
            counters.find(
              (c) => c.feature === feature && c.period === periodFor(feature),
            )?.used ?? 0;
          return [
            feature,
            {
              used,
              limit: allowance(feature),
              remaining: Math.max(0, allowance(feature) - used),
              resetsAt: resetFor(feature).toISOString(),
            },
          ];
        }),
      ),
    };
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeUsage } from "./usage_fixture";
import {
  reserve,
  settle,
  withAllowance,
  periodFor,
  resetFor,
} from "../src/services/usage";
import { mediaLink, validMediaAccess } from "../src/services/media";

test("concurrent requests cannot exceed allowance; UID and action are isolated", async (t) => {
  fakeUsage(t);
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      reserve("alice", "views", 1, `op-${i}`),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && (r.reason as any).statusCode === 429,
    ).length,
    7,
  );
  await reserve("bob", "views", 1, "op-0");
  await reserve("alice", "trips", 1, "op-0");
});
test("retries do not charge twice; failure refunds once; stale reservations are reclaimed", async (t) => {
  const store = fakeUsage(t);
  const op = await reserve("alice", "views", 2, "same-operation");
  await assert.rejects(reserve("alice", "views", 2, "same-operation"), {
    statusCode: 409,
  });
  await settle(op, false);
  await settle(op, false);
  assert.equal([...store.counters.values()][0].used, 0);
  await assert.rejects(
    withAllowance(
      "alice",
      "views",
      async () => {
        throw Error("upstream failure");
      },
      1,
      "failed",
    ),
  );
  assert.equal([...store.counters.values()][0].used, 0);
  await reserve("alice", "views", 5, "stale");
  for (const value of store.ops.values()) value.expiresAt = new Date(0);
  await reserve("alice", "views", 5, "fresh");
  assert.equal([...store.counters.values()][0].used, 5);
});
test("daily/monthly boundaries use UTC; month rollover is correct", () => {
  const now = new Date("2026-12-31T23:59:59Z");
  assert.equal(periodFor("uploads", now), "2026-12-31");
  assert.equal(periodFor("views", now), "2026-12");
  assert.equal(
    resetFor("uploads", now).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
  assert.equal(
    resetFor("views", now).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});
test("private photo links cannot be changed to another owner or asset", () => {
  process.env.MEDIA_SIGNING_KEY = "test-only-media-signing-key";
  const id = "d5f5ba71-e329-4e1e-bb32-148c5b3c7777";
  const link = new URL(
    mediaLink(`/media/${id}`, "alice"),
    "https://example.com",
  );
  const exp = link.searchParams.get("expires")!,
    sig = link.searchParams.get("signature")!;
  assert.ok(validMediaAccess(id, "alice", exp, sig));
  assert.equal(validMediaAccess(id, "bob", exp, sig), false);
  assert.equal(
    validMediaAccess("d5f5ba71-e329-4e1e-bb32-148c5b3c8888", "alice", exp, sig),
    false,
  );
  assert.equal(validMediaAccess(id, "alice", "0", sig), false);
});

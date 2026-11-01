import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { lockUser } from "../services/usage";
// Durable caps on credential/reset attempts, independent of instance restarts.
export async function protectCredentials(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const target = String(req.body?.email || req.body?.username || "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
  const key =
    "auth:" +
    createHash("sha256")
      .update(JSON.stringify([req.ip, target, req.path]))
      .digest("hex");
  const period = String(Math.floor(Date.now() / (15 * 60000)));
  try {
    const count = await prisma.$transaction(async (tx) => {
      await lockUser(tx, key);
      const counter = await tx.usageCounter.upsert({
        where: {
          userId_feature_period: { userId: key, feature: "auth", period },
        },
        create: { userId: key, feature: "auth", period, used: 1 },
        update: { used: { increment: 1 } },
      });
      return counter.used;
    });
    if (count > 10) {
      res.setHeader("Retry-After", "900");
      return res
        .status(429)
        .json({
          error:
            "Too many sign-in or recovery attempts. Please wait 15 minutes.",
        });
    }
    next();
  } catch {
    res
      .status(503)
      .json({
        error: "Sign-in is temporarily unavailable. Please try again shortly.",
      });
  }
}

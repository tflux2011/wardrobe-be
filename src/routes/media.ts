import { Router } from "express";
import { prisma } from "../lib/prisma";
import { privatePhotoUrl, validMediaAccess } from "../services/media";
export const mediaRouter = Router();
mediaRouter.get("/:id", async (req, res) => {
  const { owner, expires, signature } = req.query;
  const id = String(req.params.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (
    typeof owner !== "string" ||
    typeof expires !== "string" ||
    typeof signature !== "string" ||
    !validMediaAccess(id, owner, expires, signature)
  )
    return res.status(403).end();
  const asset = await prisma.mediaAsset.findFirst({
    where: { id, userId: owner, ready: true },
  });
  if (!asset) return res.status(404).end();
  return res.redirect(302, await privatePhotoUrl(`/media/${id}`));
});

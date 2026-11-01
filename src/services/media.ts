import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { lockUser, storageLimit } from "./usage";
import { ApiError } from "../utils/errors";
import type { Prisma } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";

export const PRIVATE_BUCKET = "clad-private";
const pattern = /^\/media\/([0-9a-f-]{36})(?:\?.*)?$/i;
export function publicApiOrigin(){
  return new URL(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://wardrobe-be-fzoh.onrender.com').origin;
}
export function mediaId(url: string): string | null {
  if(/^https?:\/\//.test(url)){
    try{const parsed=new URL(url);if(parsed.origin!==publicApiOrigin())return null;url=parsed.pathname+parsed.search;}catch{return null;}
  }
  return pattern.exec(url)?.[1] ?? null;
}
export const canonicalMedia = (url: string) =>
  mediaId(url) ? `/media/${mediaId(url)}` : url;
function secret() {
  const key =
    process.env.MEDIA_SIGNING_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Media signing is not configured");
  return key;
}
function signature(id: string, uid: string, exp: string) {
  return createHmac("sha256", secret())
    .update(JSON.stringify([id, uid, exp]))
    .digest("hex");
}
export function mediaLink(url: string, uid: string) {
  const id = mediaId(url);
  if (!id) return url;
  const exp = String(Math.floor(Date.now() / 1000) + 24 * 3600);
  return `/media/${id}?owner=${encodeURIComponent(uid)}&expires=${exp}&signature=${signature(id, uid, exp)}`;
}
export function validMediaAccess(
  id: string,
  uid: string,
  exp: string,
  sig: string,
) {
  if (
    !uid ||
    !/^\d+$/.test(exp) ||
    Number(exp) < Date.now() / 1000 ||
    Number(exp) > Date.now() / 1000 + 24 * 3600 + 60 ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(sig, "hex"),
    Buffer.from(signature(id, uid, exp), "hex"),
  );
}
// Sign only outgoing photo fields; database and caches keep stable, unsigned references.
export function signMediaResponses(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    function visit(v: any): any {
      if (Array.isArray(v)) return v.map(visit);
      if (v && typeof v === "object" && !(v instanceof Date))
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            k === "imageUrl" && typeof x === "string" && req.user
              ? (mediaId(x)?publicApiOrigin()+mediaLink(x,req.user.uid):x)
              : visit(x),
          ]),
        );
      return v;
    }
    return send(visit(body));
  }) as Response["json"];
  next();
}
export async function requirePhotoSpace(uid: string, bytes = 1) {
  const used =
    (
      await prisma.mediaAsset.aggregate({
        where: { userId: uid },
        _sum: { bytes: true },
      })
    )._sum.bytes ?? 0;
  if (used + bytes > storageLimit())
    throw new ApiError(
      429,
      "Free some photo storage before adding another photo or preview.",
      { code: "STORAGE_LIMIT" },
    );
}
export async function savePrivatePhoto(
  bytes: Buffer,
  uid: string,
  mimeType = "image/jpeg",
  legacyUrl?: string,
) {
  const id = randomUUID(),
    storagePath = `${encodeURIComponent(uid)}/${id}.${mimeType === "image/png" ? "png" : "jpg"}`;
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, uid);
    const used =
      (
        await tx.mediaAsset.aggregate({
          where: { userId: uid },
          _sum: { bytes: true },
        })
      )._sum.bytes ?? 0;
    if (!legacyUrl && used + bytes.length > storageLimit())
      throw new ApiError(
        429,
        "Your photo storage allowance is full. Remove unused pieces before adding more.",
        { code: "STORAGE_LIMIT" },
      );
    await tx.mediaAsset.create({
      data: {
        id,
        userId: uid,
        storagePath,
        bytes: bytes.length,
        mimeType,
        legacyUrl,
      },
    });
  });
  try {
    const { error } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (error) throw new Error("Private photo storage is unavailable");
    await prisma.mediaAsset.update({ where: { id }, data: { ready: true } });
    return `/media/${id}`;
  } catch (error) {
    const { error: removeError } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .remove([storagePath]);
    if (!removeError) await prisma.mediaAsset.deleteMany({ where: { id } });
    throw error;
  }
}
export async function privatePhotoUrl(url: string) {
  const id = mediaId(url);
  if (!id) throw new Error("Invalid private photo");
  const asset = await prisma.mediaAsset.findFirst({
    where: { id, ready: true },
  });
  if (!asset) throw new Error("Photo unavailable");
  const { data, error } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .createSignedUrl(asset.storagePath, 300);
  if (error || !data?.signedUrl) throw new Error("Photo unavailable");
  return data.signedUrl;
}
export async function privatePhotoBytes(url: string) {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: mediaId(url) ?? "", ready: true },
  });
  if (!asset) throw new Error("Photo unavailable");
  const { data, error } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .download(asset.storagePath);
  if (error || !data) throw new Error("Photo unavailable");
  return Buffer.from(await data.arrayBuffer());
}
export async function ownedPhoto(
  url: string,
  uid: string,
  db: Prisma.TransactionClient = prisma,
) {
  const id = mediaId(url);
  const asset = await db.mediaAsset.findFirst({
    where: id
      ? { id, userId: uid, ready: true }
      : { legacyUrl: url, userId: uid, ready: true },
  });
  if (asset) return `/media/${asset.id}`;
  // Existing legacy photos remain editable until migration; new arbitrary remote references are rejected.
  const existing = await db.clothingItem.findFirst({
    where: { userId: uid, imageUrl: url },
  });
  if (existing) return url;
  throw new ApiError(400, "Choose a photo uploaded to your own Clad account.");
}
export async function removePrivatePhotos(uid: string, ids: string[]) {
  const assets = await prisma.mediaAsset.findMany({
    where: { userId: uid, id: { in: ids } },
  });
  if (!assets.length) return;
  const { error } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .remove(assets.map((a) => a.storagePath));
  if (error) throw new Error("Could not remove private photos");
  for (const asset of assets) {
    if (!asset.legacyUrl) continue;
    const url = new URL(asset.legacyUrl),
      origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const prefix = "/storage/v1/object/public/wardrobe-images/";
    if (url.origin !== origin.origin || !url.pathname.startsWith(prefix))
      continue;
    const shared = await prisma.mediaAsset.count({
      where: {
        legacyUrl: asset.legacyUrl,
        id: { notIn: assets.map((a) => a.id) },
      },
    });
    const referenced = await prisma.clothingItem.count({
      where: { imageUrl: asset.legacyUrl },
    });
    if (!shared && !referenced) {
      const { error: oldError } = await supabase.storage
        .from("wardrobe-images")
        .remove([decodeURIComponent(url.pathname.slice(prefix.length))]);
      if (oldError) throw new Error("Original photo cleanup will retry");
    }
  }
  await prisma.mediaAsset.deleteMany({
    where: { userId: uid, id: { in: assets.map((a) => a.id) } },
  });
}

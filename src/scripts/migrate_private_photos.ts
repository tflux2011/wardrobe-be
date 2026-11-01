import "dotenv/config";
import { prisma } from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { savePrivatePhoto, privatePhotoBytes } from "../services/media";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";

async function main() {
  const items = await prisma.clothingItem.findMany({
    select: { id: true, userId: true, imageUrl: true },
  });
  const legacy = items.filter((i) => !i.imageUrl.startsWith("/media/"));
  if (!process.argv.includes("--apply")) {
    console.log(
      JSON.stringify({
        legacyPhotos: legacy.length,
        privatePhotos: items.length - legacy.length,
        mode: "dry-run",
      }),
    );
    return;
  }
  const backup = process.env.SECURITY_BACKUP_DIR;
  if (!backup)
    throw Error(
      "Set a private backup directory before applying this migration",
    );
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    `${backup}/photo-references-${Date.now()}.json`,
    JSON.stringify(items),
    { mode: 0o600 },
  );
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  let copied = 0,
    failed = 0;
  // Small batches prevent migration from overwhelming storage or the database.
  for (let start = 0; start < legacy.length; start += 3) {
    await Promise.all(
      legacy.slice(start, start + 3).map(async (item) => {
        try {
          let existing = await prisma.mediaAsset.findFirst({
            where: {
              userId: item.userId,
              legacyUrl: item.imageUrl,
              ready: true,
            },
          });
          let canonical: string;
          if (existing) canonical = `/media/${existing.id}`;
          else {
            const url = new URL(item.imageUrl);
            const prefix = "/storage/v1/object/public/wardrobe-images/";
            if (
              url.origin !== origin.origin ||
              !url.pathname.startsWith(prefix)
            )
              throw Error("Untrusted legacy photo source");
            const objectPath = decodeURIComponent(
              url.pathname.slice(prefix.length),
            );
            const { data, error } = await supabase.storage
              .from("wardrobe-images")
              .download(objectPath);
            if (error || !data) throw Error("Could not read original photo");
            const bytes = Buffer.from(await data.arrayBuffer());
            if (bytes.length > 20 * 1024 * 1024)
              throw Error("Legacy photo too large");
            const metadata = await sharp(bytes, {
              limitInputPixels: 25_000_000,
            }).metadata();
            if (!["jpeg", "png"].includes(metadata.format || ""))
              throw Error("Unsupported legacy photo");
            canonical = await savePrivatePhoto(
              bytes,
              item.userId,
              metadata.format === "png" ? "image/png" : "image/jpeg",
              item.imageUrl,
            );
            const check = await privatePhotoBytes(canonical);
            if (
              createHash("sha256").update(check).digest("hex") !==
              createHash("sha256").update(bytes).digest("hex")
            )
              throw Error("Photo verification mismatch");
          }
          await prisma.clothingItem.updateMany({
            where: {
              id: item.id,
              userId: item.userId,
              imageUrl: item.imageUrl,
            },
            data: { imageUrl: canonical },
          });
          copied++;
        } catch {
          failed++;
        }
      }),
    );
    console.log(
      JSON.stringify({
        processed: Math.min(start + 3, legacy.length),
        copied,
        failed,
      }),
    );
  }
  const remaining = await prisma.clothingItem.count({
    where: { NOT: { imageUrl: { startsWith: "/media/" } } },
  });
  if (failed || remaining)
    throw Error(
      "Some legacy photos remain. Original storage stays accessible; no originals were deleted.",
    );
  const { error } = await supabase.storage.updateBucket("wardrobe-images", {
    public: false,
  });
  if (error)
    throw Error(
      "Photo migration complete but original bucket privacy update failed",
    );
  console.log(
    JSON.stringify({
      migration: "complete",
      copied,
      remaining: 0,
      originalBucket: "private",
      originals: "retained",
    }),
  );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Private photo migration failed",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

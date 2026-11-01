import { prisma } from '../lib/prisma';
import { lockUser } from '../services/usage';
import { removePrivatePhotos } from '../services/media';
import fs from 'fs/promises';
import path from 'path';

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const GENERATED_DIR = path.join(UPLOADS_DIR, 'generated');
const SPLITS_DIR = path.join(UPLOADS_DIR, 'splits');

// Cleanup files older than 2 hours
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function cleanupDirectory(dirPath: string) {
  try {
    const files = await fs.readdir(dirPath);
    const now = Date.now();

    for (const file of files) {
      if (file === '.gitkeep') continue;
      
      const filePath = path.join(dirPath, file);
      const stats = await fs.stat(filePath);

      if (stats.isFile() && (now - stats.mtimeMs > MAX_AGE_MS)) {
        await fs.unlink(filePath);
        console.log(`[cleanup] Deleted old file: ${filePath}`);
      }
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`[cleanup] Failed to clean directory ${dirPath}:`, error);
    }
  }
}

export async function runCleanupTask() {
  console.log('[cleanup] Running scheduled cleanup...');
  await cleanupDirectory(UPLOADS_DIR);
  await cleanupDirectory(GENERATED_DIR);
  await cleanupDirectory(SPLITS_DIR);
  try {
    const before=new Date(Date.now()-48*60*60*1000);
    const assets=await prisma.$queryRaw<Array<{id:string;userId:string}>>`
      SELECT m."id",m."userId" FROM "MediaAsset" m
      WHERE m."createdAt" < ${before} AND NOT EXISTS (
        SELECT 1 FROM "ClothingItem" c WHERE c."userId"=m."userId" AND c."imageUrl"='/media/' || m."id"
      ) ORDER BY m."createdAt" ASC LIMIT 200`;
    for(const asset of assets) {
      const unused=await prisma.$transaction(async tx=>{
        await lockUser(tx,asset.userId);
        const referenced=await tx.clothingItem.count({where:{userId:asset.userId,imageUrl:`/media/${asset.id}`}});
        if(referenced)return false;
        await tx.mediaAsset.updateMany({where:{id:asset.id,userId:asset.userId},data:{ready:false}});return true;
      });
      if(unused)await removePrivatePhotos(asset.userId,[asset.id]);
    }
    const retention=new Date(Date.now()-90*24*60*60*1000);
    await prisma.usageOperation.deleteMany({where:{state:{not:'pending'},createdAt:{lt:retention}}});
    await prisma.usageCounter.deleteMany({where:{feature:{not:'auth'},period:{lt:retention.toISOString().slice(0,7)}}});
    const oldAuth=String(Math.floor((Date.now()-24*60*60*1000)/(15*60000)));
    await prisma.usageCounter.deleteMany({where:{feature:'auth',period:{lt:oldAuth}}});
  } catch {console.error('[cleanup] Private asset cleanup will retry next hour');}
}

// Run immediately, then every hour
export function startCleanupSchedule() {
  runCleanupTask();
  setInterval(runCleanupTask, 60 * 60 * 1000);
}

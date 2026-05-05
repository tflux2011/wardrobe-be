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
}

// Run immediately, then every hour
export function startCleanupSchedule() {
  runCleanupTask();
  setInterval(runCleanupTask, 60 * 60 * 1000);
}

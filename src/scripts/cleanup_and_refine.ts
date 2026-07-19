import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });
const prisma = new PrismaClient();

async function cleanAndRefine() {
  console.log('🧹 Cleaning up database: Removing raw/unrefined duplicates and keeping ONLY _full.png refined images...');

  // 1. Delete all ClothingItem records whose imageUrl does NOT contain '_full'
  const deleteResult = await prisma.clothingItem.deleteMany({
    where: {
      NOT: {
        imageUrl: {
          contains: '_full'
        }
      }
    }
  });

  console.log(`🗑️ Deleted ${deleteResult.count} unrefined / raw duplicate clothing items.`);

  // 2. Remove any exact duplicate imageUrls per user
  const targetEmails = ['tflux2011@gmail.com', 'tobi.adeosun004@gmail.com', 'tadeosun004@gmail.com'];
  
  for (const email of targetEmails) {
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) continue;

    const items = await prisma.clothingItem.findMany({
      where: { userId: user.id },
      orderBy: { addedAt: 'desc' },
    });

    const seenUrls = new Set<string>();
    const duplicateIdsToDelete: string[] = [];

    for (const item of items) {
      if (seenUrls.has(item.imageUrl)) {
        duplicateIdsToDelete.push(item.id);
      } else {
        seenUrls.add(item.imageUrl);
      }
    }

    if (duplicateIdsToDelete.length > 0) {
      await prisma.clothingItem.deleteMany({
        where: { id: { in: duplicateIdsToDelete } }
      });
      console.log(`✨ Removed ${duplicateIdsToDelete.length} duplicate items for ${email}. Unique refined items: ${seenUrls.size}`);
    } else {
      console.log(`✅ ${email} has ${seenUrls.size} unique refined (_full.png) items.`);
    }
  }

  console.log('🎉 Cleanup complete!');
}

cleanAndRefine()
  .catch((e) => console.error('Cleanup failed:', e))
  .finally(() => prisma.$disconnect());

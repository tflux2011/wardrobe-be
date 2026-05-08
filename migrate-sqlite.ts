import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';

const db = new Database('./prisma/dev.db');
const prisma = new PrismaClient();

async function migrate() {
  console.log('Starting migration...');

  try {
    // Read from SQLite
    const users = db.prepare('SELECT * FROM User').all() as any[];
    const clothingItems = db.prepare('SELECT * FROM ClothingItem').all() as any[];
    const outfits = db.prepare('SELECT * FROM Outfit').all() as any[];
    const outfitItems = db.prepare('SELECT * FROM OutfitItem').all() as any[];
    const trips = db.prepare('SELECT * FROM Trip').all() as any[];

    console.log(`Found ${users.length} users, ${clothingItems.length} clothing items, ${outfits.length} outfits, ${outfitItems.length} outfit items, ${trips.length} trips.`);

    // Migrate Users
    for (const u of users) {
      await prisma.user.upsert({
        where: { id: u.id },
        update: {},
        create: {
          id: u.id,
          createdAt: new Date(u.createdAt),
          updatedAt: new Date(u.updatedAt),
        },
      });
    }
    console.log('Migrated users.');

    // Migrate ClothingItems
    for (const item of clothingItems) {
      await prisma.clothingItem.upsert({
        where: { id: item.id },
        update: {},
        create: {
          id: item.id,
          userId: item.userId,
          name: item.name,
          category: item.category,
          style: item.style,
          colors: item.colors,
          occasions: item.occasions,
          seasons: item.seasons,
          tags: item.tags,
          imageUrl: item.imageUrl,
          localImagePath: item.localImagePath,
          price: item.price,
          wearCount: item.wearCount,
          lastWornAt: item.lastWornAt ? new Date(item.lastWornAt) : null,
          addedAt: new Date(item.addedAt),
        },
      });
    }
    console.log('Migrated clothing items.');

    // Migrate Outfits
    for (const outfit of outfits) {
      await prisma.outfit.upsert({
        where: { id: outfit.id },
        update: {},
        create: {
          id: outfit.id,
          userId: outfit.userId,
          name: outfit.name,
          occasion: outfit.occasion,
          createdAt: new Date(outfit.createdAt),
        },
      });
    }
    console.log('Migrated outfits.');

    // Migrate OutfitItems
    for (const oi of outfitItems) {
      await prisma.outfitItem.upsert({
        where: { id: oi.id },
        update: {},
        create: {
          id: oi.id,
          outfitId: oi.outfitId,
          clothingItemId: oi.clothingItemId,
        },
      });
    }
    console.log('Migrated outfit items.');

    // Migrate Trips
    for (const trip of trips) {
      await prisma.trip.upsert({
        where: { id: trip.id },
        update: {},
        create: {
          id: trip.id,
          userId: trip.userId,
          destination: trip.destination,
          startDate: new Date(trip.startDate),
          endDate: new Date(trip.endDate),
          purpose: trip.purpose,
          packingList: trip.packingList,
          dailyOutfits: trip.dailyOutfits,
          createdAt: new Date(trip.createdAt),
        },
      });
    }
    console.log('Migrated trips.');

    console.log('Migration complete!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await prisma.$disconnect();
    db.close();
  }
}

migrate();

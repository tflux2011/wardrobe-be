import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function test() {
  const items = await prisma.clothingItem.findMany();
  console.log("Items in db:", items.length);
}
test();

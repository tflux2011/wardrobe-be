import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const emails = await prisma.whitelistedEmail.findMany();
    console.log('--- Whitelisted Emails ---');
    console.log(emails);
    
    const users = await prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' }
    });
    console.log('\n--- Recent Users ---');
    console.log(users);
  } catch (error) {
    console.error('Error querying database:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

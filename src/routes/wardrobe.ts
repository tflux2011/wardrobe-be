import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';

export const wardrobeRouter = Router();

// Ensure the user exists in the DB (since Firebase handles auth, we lazily create User records)
async function ensureUser(uid: string) {
  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) {
    await prisma.user.create({ data: { id: uid } });
  }
}

// GET /api/wardrobe
wardrobeRouter.get('/', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureUser(uid);
    const items = await prisma.clothingItem.findMany({
      where: { userId: uid },
      orderBy: { addedAt: 'desc' },
    });
    
    // Parse JSON string fields back to arrays
    const formatted = items.map((item) => ({
      ...item,
      colors: JSON.parse(item.colors),
      occasions: JSON.parse(item.occasions),
      seasons: JSON.parse(item.seasons),
      tags: JSON.parse(item.tags),
    }));

    return res.json(formatted);
  } catch (error) {
    console.error('[wardrobe/get]', error);
    return res.status(500).json({ error: 'Failed to fetch wardrobe' });
  }
});

const createItemSchema = z.object({
  id: z.string().optional(), // allow client to provide id
  name: z.string(),
  category: z.string(),
  style: z.string(),
  colors: z.array(z.string()),
  occasions: z.array(z.string()),
  seasons: z.array(z.string()),
  tags: z.array(z.string()),
  imageUrl: z.string(),
  localImagePath: z.string().optional().default(''),
});

// POST /api/wardrobe
wardrobeRouter.post('/', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    await ensureUser(uid);
    const data = parsed.data;
    
    const newItem = await prisma.clothingItem.create({
      data: {
        id: data.id, // optional
        userId: uid,
        name: data.name,
        category: data.category,
        style: data.style,
        colors: JSON.stringify(data.colors),
        occasions: JSON.stringify(data.occasions),
        seasons: JSON.stringify(data.seasons),
        tags: JSON.stringify(data.tags),
        imageUrl: data.imageUrl,
        localImagePath: data.localImagePath,
      },
    });

    return res.json({
      ...newItem,
      colors: JSON.parse(newItem.colors),
      occasions: JSON.parse(newItem.occasions),
      seasons: JSON.parse(newItem.seasons),
      tags: JSON.parse(newItem.tags),
    });
  } catch (error) {
    console.error('[wardrobe/create]', error);
    return res.status(500).json({ error: 'Failed to save clothing item' });
  }
});

// DELETE /api/wardrobe/:id
wardrobeRouter.delete('/:id', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const itemId = req.params.id as string;
    // Ensure the item belongs to the user
    const item = await prisma.clothingItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    if (item.userId !== uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.clothingItem.delete({
      where: { id: itemId },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('[wardrobe/delete]', error);
    return res.status(500).json({ error: 'Failed to delete item' });
  }
});

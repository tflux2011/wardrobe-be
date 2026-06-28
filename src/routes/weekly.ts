import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateWeeklyOutfitPlanner } from '../services/claude_service';
import { prisma } from '../lib/prisma';

export const weeklyRouter = Router();

const weeklySchema = z.object({
  occasion: z.enum(['casual', 'work', 'evening', 'formal', 'sport']),
  weather: z.object({
    temp: z.number(),
    condition: z.string().min(1),
  }),
  styleProfile: z
    .object({
      skinTone: z.string().max(64).nullable().optional(),
      undertone: z.string().max(64).nullable().optional(),
      contrast: z.string().max(64).nullable().optional(),
      gender: z.string().max(32).nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

// POST /api/outfits/weekly
weeklyRouter.post('/weekly', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = weeklySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { occasion, weather, styleProfile } = parsed.data;

  try {
    const dbItems = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    if (dbItems.length === 0) {
      return res.json([]);
    }

    // Format for service
    const wardrobe = dbItems.map((item: any) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      colors: JSON.parse(item.colors),
      style: item.style,
      occasions: JSON.parse(item.occasions),
      seasons: JSON.parse(item.seasons),
      tags: JSON.parse(item.tags),
      lastWornAt: item.lastWornAt?.toISOString(),
    }));

    const suggestions = await generateWeeklyOutfitPlanner({
      occasion,
      weather,
      wardrobe,
      styleProfile: styleProfile || undefined,
    });
    return res.json(suggestions);
  } catch (err) {
    console.error('[outfits/weekly]', err);
    return res.status(500).json({ error: 'Failed to generate weekly outfit suggestions' });
  }
});

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateOutfitSuggestions } from '../services/claude_service';
import { prisma } from '../lib/prisma';

export const outfitsRouter = Router();

const suggestSchema = z.object({
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
    .nullable()
    .optional(),
  itemIds: z.array(z.string()).optional(),
});

// POST /api/outfits/suggest
outfitsRouter.post('/suggest', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { occasion, weather, styleProfile, itemIds } = parsed.data;

  try {
    const queryConditions: any = { userId: uid };
    if (itemIds && itemIds.length > 0) {
      queryConditions.id = { in: itemIds };
    }

    const dbItems = await prisma.clothingItem.findMany({
      where: queryConditions,
    });

    if (dbItems.length === 0) {
      return res.json([]);
    }

    // Format for Claude service
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

    const suggestions = await generateOutfitSuggestions({
      occasion,
      weather,
      wardrobe,
      styleProfile: styleProfile || undefined,
    });
    return res.json(suggestions);
  } catch (err) {
    console.error('[outfits/suggest]', err);
    return res.status(500).json({ error: 'Failed to generate outfit suggestions' });
  }
});

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateOutfitSuggestions } from '../services/claude_service';

export const outfitsRouter = Router();

const suggestSchema = z.object({
  occasion: z.enum(['casual', 'work', 'evening', 'formal', 'sport']),
  weather: z.object({
    temp: z.number(),
    condition: z.string().min(1),
  }),
  wardrobe: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      colors: z.array(z.string()),
      style: z.string(),
      occasions: z.array(z.string()),
      seasons: z.array(z.string()),
      tags: z.array(z.string()),
      lastWornAt: z.string().optional(),
    }),
  ),
});

// POST /api/outfits/suggest
outfitsRouter.post('/suggest', async (req: Request, res: Response) => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { occasion, weather, wardrobe } = parsed.data;

  if (wardrobe.length === 0) {
    return res.json([]);
  }

  try {
    const suggestions = await generateOutfitSuggestions({ occasion, weather, wardrobe });
    return res.json(suggestions);
  } catch (err) {
    console.error('[outfits/suggest]', err);
    return res.status(500).json({ error: 'Failed to generate outfit suggestions' });
  }
});

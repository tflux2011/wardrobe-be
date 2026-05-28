import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EmailService } from '../services/email_service';

export const wardrobeRouter = Router();

// Ensure the user exists in the DB (since Firebase handles auth, we lazily create User records)
async function ensureUser(uid: string, email?: string | null) {
  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) {
    await prisma.user.create({
      data: {
        id: uid,
        email: email || null
      }
    });

    if (email) {
      try {
        const welcomeTemplate = await prisma.emailTemplate.findUnique({
          where: { id: 'welcome' }
        });
        
        const subject = welcomeTemplate?.subject || 'Welcome to Clad Atelier // Closet Calibration Initiated';
        const bodyTemplate = welcomeTemplate?.body || EmailService.getDefaultTemplates().welcome.body;
        
        const renderedHtml = EmailService.interpolate(bodyTemplate, {
          userName: email.split('@')[0],
        });

        EmailService.sendEmail({
          to: email,
          subject,
          html: renderedHtml
        }).then(res => {
          console.log(`[Onboarding Welcome Email] Sent to ${email} (Mode: ${res.mode}, ID: ${res.id})`);
        }).catch(err => {
          console.error(`[Onboarding Welcome Email] Failed to send to ${email}:`, err);
        });
      } catch (err) {
        console.error('[Onboarding Welcome Email] Error rendering welcome email:', err);
      }
    }
  } else if (email && user.email !== email) {
    await prisma.user.update({
      where: { id: uid },
      data: { email }
    });
  }
}

// GET /api/wardrobe
wardrobeRouter.get('/', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureUser(uid, req.user?.email);
    const dbItems = await prisma.clothingItem.findMany({
      where: { userId: uid },
      orderBy: { addedAt: 'desc' },
    });
    
    // Parse JSON string fields back to arrays
    const items = dbItems.map((item: any) => ({
      ...item,
      colors: JSON.parse(item.colors),
      occasions: JSON.parse(item.occasions),
      seasons: JSON.parse(item.seasons),
      tags: JSON.parse(item.tags),
    }));

    return res.json(items);
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
  price: z.number().nullable().optional(),
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
    await ensureUser(uid, req.user?.email);
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
        price: data.price,
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

// GET /api/wardrobe/gaps
wardrobeRouter.get('/gaps', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
  }

  try {
    const dbItems = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    if (dbItems.length === 0) {
      return res.json([]);
    }

    const wardrobeContext = dbItems.map((item: any) => ({
      name: item.name,
      category: item.category,
      colors: JSON.parse(item.colors),
      style: item.style,
      occasions: JSON.parse(item.occasions),
    }));

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-2.5-flash' });

    const systemPrompt = `You are an expert personal stylist. Analyze the user's wardrobe and identify exactly 3 essential missing items (Wardrobe Gaps) that would unlock many new outfit combinations based on what they already own.
For each gap, provide:
1. "missingItem": The name of the item (e.g., "Neutral Trousers")
2. "reason": A short explanation of why they need it and what it pairs with.
3. "searchQuery": A precise search query for Google Shopping (e.g., "Mens Neutral Chino Trousers").

Return the response strictly as a JSON array of objects with keys: missingItem, reason, searchQuery.`;

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: `Wardrobe:\n${JSON.stringify(wardrobeContext, null, 2)}` }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction: systemPrompt,
    });

    const responseText = result.response.text();
    let gaps = [];
    try {
      gaps = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse gaps JSON', e);
    }

    return res.json(gaps);
  } catch (err) {
    console.error('[wardrobe/gaps]', err);
    return res.status(500).json({ error: 'Failed to analyze wardrobe gaps' });
  }
});


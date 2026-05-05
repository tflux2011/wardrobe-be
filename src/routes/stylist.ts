import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { prisma } from '../lib/prisma';

export const stylistRouter = Router();

function getGeminiModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-2.5-flash' });
}

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(40) // cap history depth to control token spend
    .default([]),
});

const STYLIST_SYSTEM_PROMPT = `You are a friendly, knowledgeable personal stylist with deep knowledge of the user's wardrobe.

Your personality:
- Warm, direct, and confident — like a stylish friend, not a salesperson
- You never suggest buying new clothes unless explicitly asked
- You know which items haven't been worn recently and gently encourage using them
- You give specific, actionable advice — not vague tips

Your capabilities:
- Suggest outfits from the wardrobe for any occasion or weather
- Explain why specific items pair well together (colour theory, formality, texture)
- Help plan outfits for trips using minimum items for maximum combinations
- Notice patterns (e.g. "you have 8 blue tops but rarely wear them")

When suggesting outfits, always reference specific items by name from the wardrobe context provided.
If the wardrobe is empty or no context is given, ask the user to add some items first.

Keep responses concise — 2-4 sentences for simple questions, short structured lists for outfit suggestions.`;

// POST /api/stylist/chat
stylistRouter.post('/chat', async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { message, history } = parsed.data;

  try {
    const dbItems = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    const wardrobeContext = dbItems.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      colors: JSON.parse(item.colors),
      style: item.style,
      occasions: JSON.parse(item.occasions),
      lastWornAt: item.lastWornAt?.toISOString(),
      wearCount: item.wearCount,
    }));

    const wardrobeStr =
      wardrobeContext && wardrobeContext.length > 0
        ? `\n\nUser's wardrobe:\n${JSON.stringify(wardrobeContext, null, 2)}`
        : "\n\nThe user has not added any wardrobe items yet.";

    const model = getGeminiModel();

    // Gemini multi-turn: build history as Content[] and send the latest message
    const chat = model.startChat({
      systemInstruction: STYLIST_SYSTEM_PROMPT + wardrobeStr,
      history: history.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      })),
    });

    const chatResult = await chat.sendMessage(message);
    const reply = chatResult.response.text() || "I'm not sure about that one — could you rephrase?";

    return res.json({ reply });
  } catch (err) {
    console.error('[stylist/chat]', err);

    const errMsg = err instanceof Error ? err.message : 'Unknown stylist error';
    if (errMsg.includes('GEMINI_API_KEY')) {
      return res.status(503).json({ error: 'Stylist service is not configured on the server' });
    }

    return res.status(500).json({ error: 'Failed to get stylist response' });
  }
});

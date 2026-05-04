import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';

export const stylistRouter = Router();

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  return new Anthropic({ apiKey });
}

function extractTextReply(content: Anthropic.Messages.Message['content']): string {
  const textBlock = content.find((block) => block.type === 'text');
  return textBlock?.type === 'text'
    ? textBlock.text
    : "I'm not sure about that one — could you rephrase?";
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
  wardrobeContext: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        category: z.string(),
        colors: z.array(z.string()),
        style: z.string(),
        occasions: z.array(z.string()),
        lastWornAt: z.string().optional(),
        wearCount: z.number().optional(),
      }),
    )
    .optional()
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
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { message, history, wardrobeContext } = parsed.data;

  const wardrobeStr =
    wardrobeContext && wardrobeContext.length > 0
      ? `\n\nUser's wardrobe:\n${JSON.stringify(wardrobeContext, null, 2)}`
      : "\n\nThe user has not added any wardrobe items yet.";

  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    })),
    { role: 'user', content: message },
  ];

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: STYLIST_SYSTEM_PROMPT + wardrobeStr,
      messages,
    });

    const reply = extractTextReply(response.content);

    return res.json({ reply });
  } catch (err) {
    console.error('[stylist/chat]', err);

    const message = err instanceof Error ? err.message : 'Unknown stylist error';
    if (message.includes('ANTHROPIC_API_KEY') || message.includes('authentication method')) {
      return res.status(503).json({ error: 'Stylist service is not configured on the server' });
    }

    if (message.includes('JSON') || message.includes('empty response')) {
      return res.status(502).json({ error: 'Stylist service returned an invalid response' });
    }

    return res.status(500).json({ error: 'Failed to get stylist response' });
  }
});

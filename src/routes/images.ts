import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';

export const imagesRouter = Router();

const imageSchema = z.object({
  prompt: z.string().min(8).max(2000),
  wardrobeContext: z.array(z.record(z.any())).optional().default([]),
});

imagesRouter.post('/inspire', async (req: Request, res: Response) => {
  const parsed = imageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.0-flash-preview-image-generation';
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(503).json({ error: 'Gemini image generation is not configured on the server' });
  }

  const wardrobeSummary = parsed.data.wardrobeContext.length > 0
    ? `\n\nUse this wardrobe context for inspiration only:\n${JSON.stringify(parsed.data.wardrobeContext, null, 2)}`
    : '';

  const prompt = `Create a polished fashion inspiration image. Do not render app UI or text overlays. Focus on editorial styling and coherent outfit composition. ${parsed.data.prompt}${wardrobeSummary}`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      },
    );

    const parts = response.data?.candidates?.[0]?.content?.parts;
    const imagePart = Array.isArray(parts)
      ? parts.find((part: any) => part.inlineData?.data)
      : null;

    if (!imagePart?.inlineData?.data) {
      return res.status(502).json({ error: 'Gemini did not return an image' });
    }

    return res.json({
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType ?? 'image/png',
      model,
    });
  } catch (error) {
    console.error('[images/inspire]', error);
    return res.status(500).json({ error: 'Failed to generate inspiration image' });
  }
});
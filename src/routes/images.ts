import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';

export const imagesRouter = Router();

const imageSchema = z.object({
  prompt: z.string().min(8).max(2000),
  wardrobeContext: z.array(z.record(z.any())).optional().default([]),
});

const defaultImageModels = [
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
];

function modelCandidatesFromEnv(): string[] {
  const primary = process.env.GEMINI_IMAGE_MODEL?.trim();
  const listFromEnv = (process.env.GEMINI_IMAGE_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const ordered = [
    ...(primary ? [primary] : []),
    ...listFromEnv,
    ...defaultImageModels,
  ];

  return [...new Set(ordered)];
}

function isRetryableModelError(message?: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('is not found') ||
    normalized.includes('not supported for generatecontent') ||
    normalized.includes('unsupported model') ||
    normalized.includes('does not support the requested response modalities')
  );
}

imagesRouter.post('/inspire', async (req: Request, res: Response) => {
  const parsed = imageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const models = modelCandidatesFromEnv();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(503).json({ error: 'Gemini image generation is not configured on the server' });
  }

  const wardrobeSummary = parsed.data.wardrobeContext.length > 0
    ? `\n\nUse this wardrobe context for inspiration only:\n${JSON.stringify(parsed.data.wardrobeContext, null, 2)}`
    : '';

  const prompt = `Create a polished fashion inspiration image. Do not render app UI or text overlays. Focus on editorial styling and coherent outfit composition. ${parsed.data.prompt}${wardrobeSummary}`;

  try {
    if (models.length === 0) {
      return res.status(503).json({ error: 'No Gemini models configured for image generation' });
    }

    let lastUpstreamStatus: number | undefined;
    let lastUpstreamCode: string | undefined;
    let lastMessage: string | undefined;

    for (const model of models) {
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
              imageConfig: {
                aspectRatio: '3:4',
              },
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
          // Try next model if this one only returned text or unsupported output.
          lastMessage = 'Gemini did not return an image';
          continue;
        }

        return res.json({
          imageBase64: imagePart.inlineData.data,
          mimeType: imagePart.inlineData.mimeType ?? 'image/png',
          model,
        });
      } catch (error) {
        if (!axios.isAxiosError(error)) {
          throw error;
        }

        const upstreamStatus = error.response?.status;
        const upstreamData = error.response?.data as
          | { error?: { message?: string; status?: string } }
          | undefined;
        const message = upstreamData?.error?.message;
        const status = upstreamData?.error?.status;

        lastUpstreamStatus = upstreamStatus;
        lastUpstreamCode = status;
        lastMessage = message;

        console.error('[images/inspire][upstream][attempt]', {
          model,
          upstreamStatus,
          status,
          message,
        });

        if (isRetryableModelError(message)) {
          continue;
        }

        return res.status(502).json({
          error: message ?? 'Gemini request failed',
          upstreamStatus,
          upstreamCode: status,
          attemptedModels: models,
        });
      }
    }

    return res.status(502).json({
      error: lastMessage ?? 'Gemini request failed for all configured models',
      upstreamStatus: lastUpstreamStatus,
      upstreamCode: lastUpstreamCode,
      attemptedModels: models,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const upstreamStatus = error.response?.status;
      const upstreamData = error.response?.data as
        | { error?: { message?: string; status?: string } }
        | undefined;
      const message = upstreamData?.error?.message;
      const status = upstreamData?.error?.status;

      console.error('[images/inspire][upstream]', {
        upstreamStatus,
        status,
        message,
      });

      return res.status(502).json({
        error: message ?? 'Gemini request failed',
        upstreamStatus,
        upstreamCode: status,
        attemptedModels: models,
      });
    }

    return res.status(500).json({ error: 'Failed to generate inspiration image' });
  }
});

// POST /api/images/outfit
// Generate front and back view outfit images in parallel and cache them
imagesRouter.post('/outfit', async (req: Request, res: Response) => {
  const parsed = imageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const models = modelCandidatesFromEnv();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(503).json({ error: 'Gemini image generation is not configured on the server' });
  }

  if (models.length === 0) {
    return res.status(503).json({ error: 'No Gemini models configured for image generation' });
  }

  const wardrobeSummary = parsed.data.wardrobeContext.length > 0
    ? `\n\nUse this wardrobe context:\n${JSON.stringify(parsed.data.wardrobeContext, null, 2)}`
    : '';

  const generateView = async (view: 'front' | 'back') => {
    const prompt = `Generate a clean, professional product-style outfit presentation. Show the complete ${view} view of the outfit. ${parsed.data.prompt}${wardrobeSummary} Studio neutral background, centered, no watermarks, no text.`;

    for (const model of models) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['image'] },
          },
        );

        const imagePart = response.data?.candidates?.[0]?.content?.parts?.find(
          (part: any) => part.inlineData?.data,
        );
        if (imagePart?.inlineData?.data) {
          return imagePart.inlineData.data;
        }
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          isRetryableModelError(
            (error.response?.data as any)?.error?.message,
          )
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Failed to generate ${view} view for all models`);
  };

  try {
    // Generate front and back in parallel
    const [frontBase64, backBase64] = await Promise.all([
      generateView('front'),
      generateView('back'),
    ]);

    return res.json({
      front: { imageBase64: frontBase64, mimeType: 'image/png' },
      back: { imageBase64: backBase64, mimeType: 'image/png' },
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message =
        (error.response?.data as any)?.error?.message ??
        'Gemini request failed';
      console.error('[images/outfit]', message);
      return res.status(502).json({ error: message });
    }

    console.error('[images/outfit]', error);
    return res.status(500).json({ error: 'Failed to generate outfit images' });
  }
});
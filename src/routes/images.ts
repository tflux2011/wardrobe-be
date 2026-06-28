import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PERMANENT_DIR = path.join(__dirname, '..', '..', 'uploads', 'permanent');
if (!fs.existsSync(PERMANENT_DIR)) {
  fs.mkdirSync(PERMANENT_DIR, { recursive: true });
}

function saveImageToDisk(base64: string): string {
  const filename = `${crypto.randomUUID()}.png`;
  const filepath = path.join(PERMANENT_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
  return `/uploads/permanent/${filename}`;
}

export const imagesRouter = Router();

const imageSchema = z.object({
  prompt: z.string().min(8).max(2000),
  wardrobeContext: z.array(z.record(z.any())).optional().default([]),
  styleProfile: z
    .object({
      skinTone: z.string().max(64).nullable().optional(),
      undertone: z.string().max(64).nullable().optional(),
      contrast: z.string().max(64).nullable().optional(),
      gender: z.string().max(32).nullable().optional(),
    })
    .nullable()
    .optional(),
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

  const prompt = `Create a polished fashion inspiration image. Do not render app UI or text overlays. Focus on editorial styling and coherent outfit composition. The subject must have a pure white or transparent background, be tightly cropped, zoomed in, and fill the entire frame from edge to edge to maximize space usage. ${parsed.data.prompt}${wardrobeSummary}`;

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

        const imageUrl = saveImageToDisk(imagePart.inlineData.data);

        return res.json({
          imageBase64: imagePart.inlineData.data, // Keeping for backward compatibility
          imageUrl,
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

  const gender = parsed.data.styleProfile?.gender?.toLowerCase() ?? 'unisex';
  let mannequinType = 'unisex retail mannequin';
  if (gender === 'male' || gender === 'men' || gender === 'man') {
    mannequinType = 'male retail mannequin';
  } else if (gender === 'female' || gender === 'women' || gender === 'woman') {
    mannequinType = 'female retail mannequin';
  }

  const wardrobeSummary = parsed.data.wardrobeContext.length > 0
    ? `\n\nUse this wardrobe context:\n${JSON.stringify(parsed.data.wardrobeContext, null, 2)}`
    : '';
  const styleProfileSummary = parsed.data.styleProfile
    ? `\n\nUser style profile: ${JSON.stringify(parsed.data.styleProfile, null, 2)}`
    : '';

  // Clean up user prompt to avoid checkerboard grid generation
  let cleanedUserPrompt = parsed.data.prompt
    .replace(/background style:\s*transparent/gi, 'Background style: solid flat warm cream sand linen background (color hex #FDFBF7)')
    .replace(/background:\s*transparent/gi, 'Background style: solid flat warm cream sand linen background (color hex #FDFBF7)');

  const generateView = async (view: 'front' | 'back') => {
    let backgroundStyleRule = 'white seamless background';
    let appBackgroundOverride = '';
    const lowercasePrompt = parsed.data.prompt.toLowerCase();
    if (lowercasePrompt.includes('background style: transparent') || lowercasePrompt.includes('background: transparent')) {
      backgroundStyleRule = 'solid flat cream sand linen color background (hex color #FDFBF7)';
      appBackgroundOverride = '\nBackground color (mandatory): Solid flat uniform cream sand linen color (Hex #FDFBF7) background. Do NOT generate checkerboard grids, transparent pixel patterns, grey-and-white grids, or alpha channels. The background must be completely solid and uniform.';
    } else if (lowercasePrompt.includes('background style: soft neutral')) {
      backgroundStyleRule = 'soft neutral gray seamless background';
    }

    const viewInstruction = view === 'front'
      ? `Camera faces the 3D model of the ${mannequinType} from the front. Entire 3D mannequin model visible from head to feet.`
      : `Camera faces the 3D model of the ${mannequinType} from the back. Entire 3D mannequin model visible from head to feet. Back of outfit only.`;
    const prompt = `Generate exactly ONE product-style fashion preview image.
Subject rules (mandatory):
- Exactly one full-body 3D digital model of a ${mannequinType} only.
- Entire 3D model mannequin must be visible from head to feet in frame.
- No human model, no real person, no extra bodies, no reflections.
- No collage, diptych, side-by-side, split-screen, before/after, or tiled layout.
- No front-and-back combined in one image.
- No text, watermark, logo, UI, props, or background scene.
View requirement: ${viewInstruction}
Output style: 3D CGI digital model render, glossy clean mannequin material, studio lighting, ${backgroundStyleRule}.${appBackgroundOverride}
Garment fit: all selected outfit pieces should appear correctly worn on the 3D model of the ${mannequinType} with realistic drape.
${cleanedUserPrompt}${wardrobeSummary}${styleProfileSummary}`;

    for (const model of models) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: { aspectRatio: '9:16' },
            },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000,
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

    const frontUrl = saveImageToDisk(frontBase64);
    const backUrl = saveImageToDisk(backBase64);

    return res.json({
      front: { imageBase64: frontBase64, imageUrl: frontUrl, mimeType: 'image/png' },
      back: { imageBase64: backBase64, imageUrl: backUrl, mimeType: 'image/png' },
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
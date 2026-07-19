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
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    if (openaiKey && openaiKey !== 'your_openai_api_key_here') {
      const openaiModels = [
        { model: 'gpt-image-2', quality: 'auto', size: '1024x1792' },
      ];
      for (const m of openaiModels) {
        try {
          console.log(`[images/inspire] Generating fashion inspiration using OpenAI ${m.model}...`);
          const bodyPayload: any = {
            model: m.model,
            prompt: prompt,
            n: 1,
            size: m.size,
          };
          if (m.quality) bodyPayload.quality = m.quality;

          const openaiRes = await axios.post(
            'https://api.openai.com/v1/images/generations',
            bodyPayload,
            {
              headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 120000,
            },
          );

          const imgUrl = openaiRes.data?.data?.[0]?.url;
          const b64Json = openaiRes.data?.data?.[0]?.b64_json;
          let b64Data = b64Json;

          if (!b64Data && imgUrl) {
            const imgDownload = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
            b64Data = Buffer.from(imgDownload.data).toString('base64');
          }

          if (b64Data) {
            const imageUrl = saveImageToDisk(b64Data);
            return res.json({
              imageBase64: b64Data,
              imageUrl,
              mimeType: 'image/png',
              model: m,
            });
          }
        } catch (err: any) {
          console.warn(`[images/inspire] OpenAI ${m} generation failed:`, err.response?.data || err.message);
        }
      }
    }

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

  const explicitGarmentList = parsed.data.wardrobeContext.map((item: any) => {
    const colorsStr = Array.isArray(item.colors) && item.colors.length > 0 
      ? item.colors.join(', ') 
      : (typeof item.colors === 'string' && item.colors ? item.colors : 'specified color');
    return `- ${item.category?.toUpperCase() || 'GARMENT'}: "${item.name}" (EXACT COLOR: ${colorsStr.toUpperCase()})`;
  }).join('\n');

  const wardrobeSummary = explicitGarmentList.length > 0
    ? `\n\nEXACT OUTFIT GARMENTS & MANDATORY COLORS:\n${explicitGarmentList}`
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

    const genderConstraint = (gender === 'male' || gender === 'men' || gender === 'man')
      ? 'The mannequin must strictly have a masculine physical build, form, and silhouette. Avoid any feminine features, shapes, curves, or styling details.'
      : (gender === 'female' || gender === 'women' || gender === 'woman')
        ? 'The mannequin must strictly have a feminine physical build, form, and silhouette.'
        : 'The mannequin should have a neutral unisex physical build.';

    const prompt = `Generate exactly ONE product-style fashion preview image of a mannequin wearing the specified outfit.
Subject rules (mandatory):
- Exactly one full-body 3D digital model of a ${mannequinType} only.
- ${genderConstraint}
- Entire 3D model mannequin must be visible from head to feet in frame.
- No human model, no real person, no extra bodies, no reflections.
- No collage, diptych, side-by-side, split-screen, before/after, or tiled layout.
- No front-and-back combined in one image.
- No text, watermark, logo, UI, props, or background scene.
View requirement: ${viewInstruction}

STRICT COLOR & GARMENT ACCURACY (MANDATORY):
- Match the EXACT colors of each specified piece below.
- DO NOT CHANGE OR SUBSTITUTE COLORS (e.g. if a shirt is green, it MUST be rendered in green, NOT blue or black).
- Render the exact colorways, sleeve length, collar, pattern, and silhouette of each specified item.
- Dress the ${mannequinType} in these exact pieces with realistic fabric drape.
Output style: 3D CGI digital model render, glossy clean mannequin material, studio lighting, ${backgroundStyleRule}.${appBackgroundOverride}
${cleanedUserPrompt}${wardrobeSummary}${styleProfileSummary}`;

    // Try OpenAI models (gpt-image-2 then dall-e-3 then dall-e-2) if OPENAI_API_KEY is configured
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    if (openaiKey && openaiKey !== 'your_openai_api_key_here') {
      const openaiModels = [
        { model: 'gpt-image-2', size: '1024x1792', quality: 'auto' },
      ];

      for (const m of openaiModels) {
        try {
          console.log(`[images/outfit] Generating ${view} view using OpenAI ${m.model}...`);
          const bodyPayload: any = {
            model: m.model,
            prompt: prompt,
            n: 1,
            size: m.size,
          };
          if (m.quality) bodyPayload.quality = m.quality;

          const openaiRes = await axios.post(
            'https://api.openai.com/v1/images/generations',
            bodyPayload,
            {
              headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 120000,
            },
          );

          const imgUrl = openaiRes.data?.data?.[0]?.url;
          const b64Json = openaiRes.data?.data?.[0]?.b64_json;
          let b64Data = b64Json;

          if (!b64Data && imgUrl) {
            const imgDownload = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
            b64Data = Buffer.from(imgDownload.data).toString('base64');
          }

          if (b64Data) {
            console.log(`[images/outfit] OpenAI ${m.model} ${view} view generated successfully!`);
            return b64Data;
          }
        } catch (err: any) {
          console.warn(`[images/outfit] OpenAI ${m.model} failed for ${view} view:`, err.response?.data || err.message);
        }
      }
    }

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
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { PreviewCache } from '../services/preview_cache';
import { generateReferencedOutfit, generateOutfitView } from '../services/outfit_image_service';

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
const previews = new PreviewCache();

const imageSchema = z.object({
  prompt: z.string().min(8).max(2000),
  view: z.enum(['front', 'back']).optional(),
  frontPreviewId: z.string().uuid().optional(),
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

// Resolve references from the signed-in user's wardrobe, never client-supplied URLs.
imagesRouter.post(['/outfit', '/outfit/reference'], async (req: Request, res: Response) => {
  const parsed = imageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ error: 'Sign in to preview your outfit.' });
  const ids = parsed.data.wardrobeContext.map(item => item.id);
  if (ids.length < 1 || ids.length > 12 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Select between one and twelve saved clothing items.' });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) return res.status(503).json({ error: 'OpenAI mannequin previews are not configured.' });
  try {
    const items = await prisma.clothingItem.findMany({ where: { userId: uid, id: { in: ids } } });
    if (items.length !== ids.length) return res.status(422).json({ error: 'Some selected pieces are unavailable. Sync your closet and try again.' });
    const ordered = ids.map(id => items.find(item => item.id === id)!);
    if (ordered.some(item => !item.imageUrl)) return res.status(422).json({ error: 'Every selected piece needs a photograph before creating a mannequin preview.' });
    if (parsed.data.view) {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
        uid, ordered.map(p => [p.id,p.name,p.category,p.imageUrl]), parsed.data.prompt,
        parsed.data.styleProfile ?? {}, process.env.OPENAI_OUTFIT_IMAGE_MODEL || 'gpt-image-2', 'photo-references-v3',
      ])).digest('hex');
      const view = parsed.data.view;
      const result = await previews.generate(fingerprint, view, async front => {
        const frontBytes = front ? (await fs.promises.readFile(path.join(__dirname, '../..', front.imageUrl))).toString('base64') : undefined;
        const image = await generateOutfitView(ordered, parsed.data.prompt, JSON.stringify(parsed.data.styleProfile ?? {}), view, frontBytes);
        return { imageUrl: saveImageToDisk(image), mimeType: 'image/png' };
      }, parsed.data.frontPreviewId);
      return res.json({ ...result, referenceItemIds: ids, generationVersion: 'photo-references-v3' });
    }
    const result = await generateReferencedOutfit(ordered, parsed.data.prompt,
      JSON.stringify(parsed.data.styleProfile ?? {}));
    return res.json({
      front: { imageBase64: result.front, imageUrl: saveImageToDisk(result.front), mimeType: 'image/png' },
      back: { imageBase64: result.back, imageUrl: saveImageToDisk(result.back), mimeType: 'image/png' },
      model: result.model, referenceItemIds: result.referenceItemIds, generationVersion: result.generationVersion,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'FRONT_PREVIEW_EXPIRED') return res.status(409).json({error:'This preview expired. Open the outfit again to create a fresh front view.'});
    if (error instanceof Error && error.message === 'PREVIEW_BUSY') return res.status(429).json({error:'The mannequin studio is busy. Please try again shortly.'});
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    console.error('[images/outfit] Reference-based generation failed', { status });
    return res.status(502).json({ error: status === 401 || status === 403
      ? 'The mannequin generator could not access the configured OpenAI project.'
      : status === 429 ? 'The mannequin generator is busy or has reached its usage limit. Please try again later.'
      : 'Could not create a photo-based mannequin preview. Your original clothing photos are unchanged.' });
  }
});

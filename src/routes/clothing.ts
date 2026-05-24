import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import axios from 'axios';
import { detectGarmentRegions, tagClothingItem, generateStoreItemMatches } from '../services/claude_service';
import { prisma } from '../lib/prisma';
import { uploadBufferToSupabase, uploadLocalFileToSupabase } from '../lib/supabase';

export const clothingRouter = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const SPLITS_DIR = path.join(UPLOADS_DIR, 'splits');
const GENERATED_DIR = path.join(UPLOADS_DIR, 'generated');
const MAX_SPLIT_REGIONS = 4;
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(SPLITS_DIR)) {
  fs.mkdirSync(SPLITS_DIR, { recursive: true });
}
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function imageModelCandidates(): string[] {
  const primary = process.env.GEMINI_IMAGE_MODEL?.trim();
  const fromList = (process.env.GEMINI_IMAGE_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const defaults = [
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image-preview',
  ];

  return [...new Set([...(primary ? [primary] : []), ...fromList, ...defaults])];
}

function isRetryableModelError(message?: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('is not found')
    || normalized.includes('does not support the requested response modalities')
    || normalized.includes('not supported for generatecontent')
    || normalized.includes('unsupported model');
}

function expandRegion(
  box: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  ratio = 0.22,
) {
  const padX = Math.round(box.width * ratio);
  const padY = Math.round(box.height * ratio);

  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const right = Math.min(imageWidth, box.x + box.width + padX);
  const bottom = Math.min(imageHeight, box.y + box.height + padY);

  return {
    x,
    y,
    width: Math.max(32, right - x),
    height: Math.max(32, bottom - y),
  };
}

async function generateFullGarmentImage(
  croppedPath: string,
  hints?: { category?: string; colors?: string[]; style?: string; name?: string },
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null;
  }

  const content = fs.readFileSync(croppedPath);
  const inputBase64 = content.toString('base64');
  const models = imageModelCandidates();
  const styleHint = hints?.style ? ` Style direction: ${hints.style}.` : '';
  const colorHint = hints?.colors && hints.colors.length > 0
    ? ` Dominant colors: ${hints.colors.join(', ')}.`
    : '';
  const categoryHint = hints?.category ? ` Garment type: ${hints.category}.` : '';
  const nameHint = hints?.name ? ` Item name: ${hints.name}.` : '';

  const prompt = `Given the reference garment image, generate a complete full-length product-style image of the same clothing item.${categoryHint}${nameHint}${colorHint}${styleHint} Keep the exact garment design and texture. Show the full clothing piece centered, uncropped, neutral studio background, no mannequin, no person, no text, no watermark.`;

  for (const model of models) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: inputBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: '3:4' },
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

      const generatedBase64 = imagePart?.inlineData?.data as string | undefined;
      if (!generatedBase64) {
        continue;
      }

      const generatedFilename = `${randomUUID()}_full.png`;
      try {
        const publicUrl = await uploadBufferToSupabase(
          Buffer.from(generatedBase64, 'base64'),
          generatedFilename
        );
        return publicUrl;
      } catch (uploadError) {
        console.error('Failed to upload enhanced image to Supabase:', uploadError);
        return null;
      }
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        continue;
      }

      const upstreamData = error.response?.data as
        | { error?: { message?: string } }
        | undefined;
      const message = upstreamData?.error?.message;

      if (isRetryableModelError(message)) {
        continue;
      }

      return null;
    }
  }

  return null;
}

/**
 * Multer config — accept only JPEG/PNG, max 10 MB.
 * Files are stored with a UUID filename to prevent path traversal.
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG images are allowed'));
    }
  },
});

function handleSingleImageUpload(req: Request, res: Response, next: () => void) {
  upload.single('image')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image size must be 10MB or less' });
      }
      return res.status(400).json({ error: 'Invalid upload request' });
    }

    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }

    return next();
  });
}

// POST /api/clothing/upload
// Accepts multipart/form-data with field "image"
clothingRouter.post('/upload', (req: Request, res: Response, next) => {
  handleSingleImageUpload(req, res, next);
}, async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  try {
    const tags = await tagClothingItem(req.file.path);

    const enhancedImageUrl = await generateFullGarmentImage(req.file.path, {
      category: tags.category,
      colors: tags.colors,
      style: tags.style,
      name: tags.name,
    });

    // Build a publicly accessible imageUrl
    let imageUrl = enhancedImageUrl;
    if (!imageUrl) {
      try {
        imageUrl = await uploadLocalFileToSupabase(req.file.path, req.file.filename);
        fs.unlink(req.file.path, () => undefined);
      } catch (uploadErr) {
        console.error('Failed to upload raw image to Supabase', uploadErr);
        imageUrl = `/uploads/${req.file.filename}`;
      }
    } else {
      fs.unlink(req.file.path, () => undefined);
    }

    return res.json({ ...tags, imageUrl });
  } catch (err) {
    // Clean up the uploaded file on processing failure
    fs.unlink(req.file.path, () => undefined);
    console.error('[clothing/upload]', err);

    const message = err instanceof Error ? err.message : 'Unknown upload error';
    if (message.includes('ANTHROPIC_API_KEY') || message.includes('authentication method')) {
      return res.status(503).json({ error: 'Tagging service is not configured on the server' });
    }

    if (message.includes('empty response') || message.includes('JSON')) {
      return res.status(502).json({ error: 'Tagging service returned an invalid response' });
    }

    return res.status(500).json({ error: 'Failed to analyse image' });
  }
});

// POST /api/clothing/split
// Accepts multipart/form-data with field "image" and returns split+tagged garments.
clothingRouter.post('/split', (req: Request, res: Response, next) => {
  handleSingleImageUpload(req, res, next);
}, async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  const uploadedPath = req.file.path;
  const uploadedFilename = req.file.filename;

  try {
    const metadata = await sharp(uploadedPath).metadata();
    if (!metadata.width || !metadata.height) {
      return res.status(400).json({ error: 'Could not read image dimensions' });
    }

    const regions = await detectGarmentRegions(uploadedPath, metadata.width, metadata.height);
    const selectedRegions = regions.slice(0, MAX_SPLIT_REGIONS);

    if (selectedRegions.length <= 1) {
      const singleTags = await tagClothingItem(uploadedPath);
      const enhancedImageUrl = await generateFullGarmentImage(uploadedPath, {
        category: singleTags.category,
        colors: singleTags.colors,
        style: singleTags.style,
        name: singleTags.name,
      });
      let imageUrl = enhancedImageUrl;
      if (!imageUrl) {
        try {
          imageUrl = await uploadLocalFileToSupabase(uploadedPath, uploadedFilename);
          fs.unlink(uploadedPath, () => undefined);
        } catch (uploadErr) {
          console.error('Failed to upload single split raw image to Supabase', uploadErr);
          imageUrl = `/uploads/${uploadedFilename}`;
        }
      } else {
        fs.unlink(uploadedPath, () => undefined);
      }
      return res.json({
        items: [{
          ...singleTags,
          imageUrl,
          source: 'full',
        }],
      });
    }

    const itemResults = await Promise.allSettled(selectedRegions.map(async (region) => {
      const filename = `${randomUUID()}.png`;
      const outputPath = path.join(SPLITS_DIR, filename);
      const expanded = expandRegion(
        { x: region.x, y: region.y, width: region.width, height: region.height },
        metadata.width,
        metadata.height,
      );

      await sharp(uploadedPath)
        .extract({
          left: expanded.x,
          top: expanded.y,
          width: expanded.width,
          height: expanded.height,
        })
        .png()
        .toFile(outputPath);

      const tags = await tagClothingItem(outputPath, { categoryHint: region.category });
      let imageUrl = `/uploads/splits/${filename}`;
      try {
        imageUrl = await uploadLocalFileToSupabase(outputPath, filename);
        fs.unlink(outputPath, () => undefined);
      } catch (uploadErr) {
        console.error('Failed to upload split crop to Supabase', uploadErr);
      }

      return {
        ...tags,
        imageUrl,
        source: 'split',
        box: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
      };
    }));

    const items = itemResults
      .flatMap((result) => {
        if (result.status === 'fulfilled') {
          return [result.value];
        }
        console.error('[clothing/split][tag]', result.reason);
        return [];
      });

    if (items.length === 0) {
      return res.status(502).json({ error: 'Could not tag detected garments from image' });
    }

    fs.unlink(uploadedPath, () => undefined);
    return res.json({ items });
  } catch (err) {
    console.error('[clothing/split]', err);

    const message = err instanceof Error ? err.message : 'Unknown split error';
    if (message.includes('ANTHROPIC_API_KEY') || message.includes('authentication method')) {
      return res.status(503).json({ error: 'Tagging service is not configured on the server' });
    }

    if (message.includes('empty response') || message.includes('JSON')) {
      return res.status(502).json({ error: 'Tagging service returned an invalid response' });
    }

    return res.status(500).json({ error: 'Failed to split and analyse image' });
  }
});

// POST /api/clothing/match
// Accepts multipart/form-data with field "image"
// Tags store garment and recommends top 3 matching items in their closet
clothingRouter.post('/match', (req: Request, res: Response, next) => {
  handleSingleImageUpload(req, res, next);
}, async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const uid = req.user?.uid;
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Tag photographed retail garment using AI
    const tags = await tagClothingItem(req.file.path);

    // 2. Fetch user's existing wardrobe items
    const wardrobe = await prisma.clothingItem.findMany({
      where: { userId: uid },
    });

    const storeItem = {
      name: tags.name,
      category: tags.category,
      colors: tags.colors,
      style: tags.style,
      occasions: tags.occasions,
      seasons: tags.seasons,
      tags: tags.tags,
    };

    let matches: any[] = [];
    if (wardrobe.length > 0) {
      // 3. Select top 3 matches using AI stylist matcher
      matches = await generateStoreItemMatches({
        storeItem,
        wardrobe,
      });
    }

    // Publicly accessible URL relative to origin
    const imageUrl = `/uploads/${req.file.filename}`;

    return res.json({
      storeItem: {
        ...tags,
        imageUrl,
      },
      matches,
    });
  } catch (err) {
    // Clean up file upload
    fs.unlink(req.file.path, () => undefined);
    console.error('[clothing/match]', err);
    return res.status(500).json({ error: 'Failed to process store item match' });
  }
});

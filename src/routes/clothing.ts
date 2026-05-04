import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { detectGarmentRegions, tagClothingItem } from '../services/claude_service';

export const clothingRouter = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const SPLITS_DIR = path.join(UPLOADS_DIR, 'splits');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(SPLITS_DIR)) {
  fs.mkdirSync(SPLITS_DIR, { recursive: true });
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

    // Build a publicly accessible imageUrl relative to the server origin
    const imageUrl = `/uploads/${req.file.filename}`;

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

  try {
    const metadata = await sharp(req.file.path).metadata();
    if (!metadata.width || !metadata.height) {
      return res.status(400).json({ error: 'Could not read image dimensions' });
    }

    const regions = await detectGarmentRegions(req.file.path, metadata.width, metadata.height);
    const selectedRegions = regions.slice(0, 6);

    if (selectedRegions.length <= 1) {
      const singleTags = await tagClothingItem(req.file.path);
      const imageUrl = `/uploads/${req.file.filename}`;
      return res.json({
        items: [{
          ...singleTags,
          imageUrl,
          source: 'full',
        }],
      });
    }

    const items: Array<Record<string, unknown>> = [];

    for (const region of selectedRegions) {
      const filename = `${randomUUID()}.png`;
      const outputPath = path.join(SPLITS_DIR, filename);

      await sharp(req.file.path)
        .extract({
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        })
        .png()
        .toFile(outputPath);

      try {
        const tags = await tagClothingItem(outputPath, { categoryHint: region.category });
        items.push({
          ...tags,
          imageUrl: `/uploads/splits/${filename}`,
          source: 'split',
          box: {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
          },
        });
      } catch (tagErr) {
        console.error('[clothing/split][tag]', tagErr);
      }
    }

    if (items.length === 0) {
      return res.status(502).json({ error: 'Could not tag detected garments from image' });
    }

    fs.unlink(req.file.path, () => undefined);
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

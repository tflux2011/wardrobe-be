import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { validateBuildGuidance } from '../services/build_guidance';
import sharp from 'sharp';
import { detectGarmentRegions, tagClothingItem, generateStoreItemMatches, analyzeBuildPhoto } from '../services/claude_service';
import { prisma } from '../lib/prisma';
import { savePrivatePhoto, requirePhotoSpace } from '../services/media';
import { reserve, settle, garmentLimit, reservePlatformBudget, positiveSetting } from '../services/usage';
import { ApiError } from '../utils/errors';

export const clothingRouter = Router();

async function resizeImageInPlace(filePath: string, maxWidth=1024, maxHeight=1024) {
  const tempPath=`${filePath}_temp`;
  try {
    const image=sharp(filePath,{limitInputPixels:25_000_000,failOn:'warning'});
    const metadata=await image.metadata();
    if(!['jpeg','png'].includes(metadata.format||'') || !metadata.width || !metadata.height)throw new Error('Unsupported image');
    await image.rotate().flatten({background:'#ffffff'}).resize({width:maxWidth,height:maxHeight,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toFile(tempPath);
    fs.renameSync(tempPath,filePath);
  } catch {
    fs.unlink(tempPath,()=>undefined);
    throw new ApiError(400,'Choose a valid JPEG or PNG photo with no more than 25 million pixels.');
  }
}
async function saveUploadedPhoto(filePath:string,uid:string) {
  const bytes=await fs.promises.readFile(filePath);
  const metadata=await sharp(bytes).metadata();
  return savePrivatePhoto(bytes,uid,metadata.format==='png'?'image/png':'image/jpeg');
}
async function uploadAllowance(req:Request,res:Response,next:import('express').NextFunction) {
  try {
    if(req.method!=='POST'||!['/upload','/split','/match','/build-photo'].includes(req.path))return next();
    const uid=req.user!.uid;
    if(['/upload','/split'].includes(req.path) && await prisma.clothingItem.count({where:{userId:uid}})>=garmentLimit())throw new ApiError(429,'Your closet allowance is full. You can still edit or remove your existing pieces.');
    const id=await reserve(uid,'uploads',1,typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined);
    // Upload attempts count even if decoding/analysis fails, preventing free repeated AI work.
    try{await reservePlatformBudget('uploads',1,positiveSetting('DAILY_PLATFORM_UPLOAD_LIMIT',2000));await settle(id,true);}catch(error){await settle(id,false);throw error;}next();
  }catch(error){next(error);}
}
clothingRouter.use(uploadAllowance);

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

/**
 * Multer config — accept only JPEG/PNG, max 10 MB.
 * Files are stored with a UUID filename to prevent path traversal.
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${randomUUID()}.jpg`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files:1, fields:8, parts:9, fieldSize:16*1024 }, // 10 MB
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

clothingRouter.post('/build-photo',(req,res,next)=>handleSingleImageUpload(req,res,next),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a full-body photo.'});
  try{
    await resizeImageInPlace(req.file.path);
    const result=await analyzeBuildPhoto(req.file.path);
    return res.json(validateBuildGuidance(result));
  }catch(error){return res.status(error instanceof ApiError?error.statusCode:502).json({error:error instanceof ApiError?error.message:'Could not assess this photo. You can use measurements instead.'});}
  finally{fs.unlink(req.file.path,()=>undefined);fs.unlink(req.file.path+'_temp',()=>undefined);}
});

// POST /api/clothing/upload
// Accepts multipart/form-data with field "image"
clothingRouter.post('/upload', (req: Request, res: Response, next) => {
  handleSingleImageUpload(req, res, next);
}, async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  try {
    // 1. Perform in-place image downscaling and compression immediately
    await resizeImageInPlace(req.file.path);
    await requirePhotoSpace(req.user!.uid,fs.statSync(req.file.path).size);

    // 2. Extract clothing tags from the lightweight resized image (~2 seconds)
    const tags = await tagClothingItem(req.file.path);

    // 3. Upload the resized raw image to Supabase immediately
    let rawImageUrl: string;
    try {
      rawImageUrl = await saveUploadedPhoto(req.file.path, req.user!.uid);
    } catch (uploadErr: any) {
      console.error('Failed to upload raw resized image to Supabase', uploadErr);
      throw uploadErr;
    }

    // 4. Return the extracted tags and rawImageUrl to the client immediately (UX: fast response!)
    res.json({ ...tags, imageUrl: rawImageUrl });

    // Preserve the real garment. Background cutouts are display-only on-device.
    fs.unlink(req.file.path,()=>undefined);

  } catch (err) {
    // Clean up the uploaded file on processing failure
    fs.unlink(req.file.path, () => undefined);
    if(err instanceof ApiError)return res.status(err.statusCode).json({error:err.message,details:err.details});
    console.error('[clothing/upload] Processing failed');

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
  const croppedPaths:string[]=[];

  try {
    // 1. Perform in-place image downscaling and compression immediately
    await resizeImageInPlace(uploadedPath);
    await requirePhotoSpace(req.user!.uid,fs.statSync(uploadedPath).size);

    const metadata = await sharp(uploadedPath).metadata();
    if (!metadata.width || !metadata.height) {
      return res.status(400).json({ error: 'Could not read image dimensions' });
    }

    const regions = await detectGarmentRegions(uploadedPath, metadata.width, metadata.height);
    const selectedRegions = regions.slice(0, MAX_SPLIT_REGIONS);

    if (selectedRegions.length <= 1) {
      const singleTags = await tagClothingItem(uploadedPath);
      const imageUrl=await saveUploadedPhoto(uploadedPath,req.user!.uid);
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
      croppedPaths.push(outputPath);
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
      let imageUrl: string;
      try {
        imageUrl = await saveUploadedPhoto(outputPath, req.user!.uid);
        fs.unlink(outputPath, () => undefined);
      } catch (uploadErr: any) {
        console.error('Failed to upload split crop to Supabase', uploadErr);
        throw uploadErr;
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
    if(err instanceof ApiError)return res.status(err.statusCode).json({error:err.message,details:err.details});
    console.error('[clothing/split] Processing failed');

    const message = err instanceof Error ? err.message : 'Unknown split error';
    if (message.includes('ANTHROPIC_API_KEY') || message.includes('authentication method')) {
      return res.status(503).json({ error: 'Tagging service is not configured on the server' });
    }

    if (message.includes('empty response') || message.includes('JSON')) {
      return res.status(502).json({ error: 'Tagging service returned an invalid response' });
    }

    return res.status(500).json({ error: 'Failed to split and analyse image' });
  } finally {
    for(const file of [uploadedPath,...croppedPaths])fs.unlink(file,()=>undefined);
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
    // 1. Perform in-place image downscaling and compression immediately
    await resizeImageInPlace(req.file.path);
    await requirePhotoSpace(req.user!.uid,fs.statSync(req.file.path).size);

    // 2. Tag photographed retail garment using AI
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

    // Upload retail garment image to Supabase Storage
    let imageUrl: string;
    try {
      imageUrl = await saveUploadedPhoto(req.file.path, req.user!.uid);
      fs.unlink(req.file.path, () => undefined);
    } catch (uploadErr: any) {
      console.error('Failed to upload retail garment to Supabase', uploadErr);
      throw uploadErr;
    }

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
    if(err instanceof ApiError)return res.status(err.statusCode).json({error:err.message,details:err.details});
    console.error('[clothing/match] Processing failed');
    return res.status(500).json({ error: 'Failed to process store item match' });
  }
});

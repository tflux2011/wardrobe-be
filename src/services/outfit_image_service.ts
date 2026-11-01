import axios from 'axios';
import { mediaId, privatePhotoUrl } from './media';
import fs from 'node:fs/promises';
import path from 'node:path';

export type GarmentReference = { id: string; name: string; category: string; imageUrl: string };
export type ImageEditor = (prompt: string, images: string[]) => Promise<string>;

/** Fail closed: a missing photograph must never become a text-only guess. */
export async function referenceImage(source: string): Promise<string> {
  if (mediaId(source)) return privatePhotoUrl(source);
  if (/^https:\/\//i.test(source)) {
    const allowed=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL||'https://invalid.local');
    const url=new URL(source);
    if(url.origin!==allowed.origin||!url.pathname.startsWith('/storage/v1/object/'))throw new Error('Untrusted garment photograph');
    return source;
  }
  if (!source.startsWith('/uploads/')) throw new Error('A selected garment has no usable photograph.');
  const root = path.resolve(__dirname, '../../uploads');
  const filename = path.resolve(root, source.slice('/uploads/'.length));
  if (!filename.startsWith(root + path.sep)) throw new Error('Invalid garment photograph.');
  const actual = await fs.realpath(filename);
  if (!actual.startsWith(root + path.sep)) throw new Error('Invalid garment photograph.');
  const bytes = await fs.readFile(actual);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Garment photograph is too large.');
  const extension = path.extname(actual).toLowerCase();
  const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : null;
  if (!mime) throw new Error('Unsupported garment photograph.');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export const editOutfitImage: ImageEditor = async (prompt, images) => {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('OpenAI mannequin previews are not configured.');
  const response = await axios.post('https://api.openai.com/v1/images/edits', {
    model: process.env.OPENAI_OUTFIT_IMAGE_MODEL || 'gpt-image-2',
    prompt, images: images.map(image_url => ({ image_url })),
    size: '1024x1536', quality: 'high', output_format: 'png', n: 1,
  }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 180000, maxBodyLength: 100 * 1024 * 1024 });
  const image = response.data?.data?.[0]?.b64_json;
  if (typeof image !== 'string' || !image) throw new Error('The mannequin generator returned no image.');
  return image;
};

async function prepare(garments: GarmentReference[], styling: string, presentation: string) {
  if (garments.length === 0 || garments.length > 12 || new Set(garments.map(g => g.id)).size !== garments.length) {
    throw new Error('Select between one and twelve unique garments.');
  }
  const images = await Promise.all(garments.map(g => referenceImage(g.imageUrl)));
  const list = garments.map((g, i) => `Reference ${i + 1}: ${g.category} — ${g.name}`).join('\n');
  const rules = `Create ONE full-body faceless retail mannequin wearing exactly the garments in the supplied photographs.\n${list}\nThe photographs are the source of truth. Preserve their colors, patterns, material, sleeve lengths, collars, closures, fit, footwear and accessory details. Transfer these pieces onto the mannequin; do not invent a new outfit, add garments, substitute colors, or treat references as inspiration. Naturally layer the selected pieces. Keep accessories at realistic scale. Do not copy photograph backgrounds, hangers, people, or display stands. White studio background, soft natural lighting, entire mannequin head-to-toe visible, no text, collage or extra mannequins. Presentation and proportions: ${presentation}. Styling notes are subordinate to photograph accuracy: ${styling}`;
  return { images, rules };
}
export async function generateOutfitView(
  garments: GarmentReference[], styling: string, presentation: string,
  view: 'front' | 'back', front?: string, editor: ImageEditor = editOutfitImage,
) {
  const {images,rules}=await prepare(garments,styling,presentation);
  if(view==='front') return editor(`${rules}\nView: FRONT, facing the camera.`, images);
  if(!front) throw new Error('Create the front preview first.');
  return editor(`${rules}\nThe FIRST image is the completed FRONT view. Subsequent images are the same garment references in the order listed. Rotate that SAME dressed mannequin 180 degrees to show its BACK. Keep the same outfit, body, colors, materials and lighting. Infer only unseen back details conservatively; do not invent prints, logos or embellishments.`, [`data:image/png;base64,${front}`, ...images]);
}
export async function generateReferencedOutfit(
  garments: GarmentReference[], styling: string, presentation: string,
  editor: ImageEditor = editOutfitImage,
) {
  const front=await generateOutfitView(garments,styling,presentation,'front',undefined,editor);
  const back=await generateOutfitView(garments,styling,presentation,'back',front,editor);
  return { front, back, model: process.env.OPENAI_OUTFIT_IMAGE_MODEL || 'gpt-image-2', referenceItemIds: garments.map(g => g.id), generationVersion: 'photo-references-v2' };
}

import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';

function getGeminiModel(modelName = 'gemini-2.5-flash'): ReturnType<GoogleGenerativeAI['getGenerativeModel']> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
}

function parseJsonResponse<T>(rawText: string): T {
  const clean = rawText.replace(/```json|```/g, '').trim();
  return JSON.parse(clean) as T;
}

export interface ClothingTag {
  name: string;
  category: 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes' | 'accessory' | 'bag';
  colors: string[];
  style: 'casual' | 'smart' | 'formal' | 'sport' | 'streetwear';
  occasions: string[];
  seasons: string[];
  tags: string[];
  brand?: string;
  confidence: number;
  needsReview: boolean;
}

interface RawClothingTag extends Partial<ClothingTag> {
  confidence?: number;
  isUncertain?: boolean;
}

const VALID_STYLES: ClothingTag['style'][] = [
  'casual',
  'smart',
  'formal',
  'sport',
  'streetwear',
];

const VALID_OCCASIONS = ['casual', 'work', 'evening', 'formal', 'sport'];
const VALID_SEASONS = ['spring', 'summer', 'autumn', 'winter'];

const BANNED_UNDERGARMENT_TERMS = [
  'bra',
  'bralette',
  'lingerie',
  'underwear',
  'panties',
  'panty',
  'thong',
];

function containsBannedUndergarmentTerm(value: string): boolean {
  const lower = value.toLowerCase();
  return BANNED_UNDERGARMENT_TERMS.some((term) => {
    const pattern = new RegExp(`\\b${term}\\b`, 'i');
    return pattern.test(lower);
  });
}

function defaultNameForCategory(category: ClothingTag['category']): string {
  switch (category) {
    case 'top':
      return 'Top item';
    case 'bottom':
      return 'Bottom item';
    case 'dress':
      return 'Dress';
    case 'outerwear':
      return 'Outerwear';
    case 'shoes':
      return 'Shoes';
    case 'bag':
      return 'Bag';
    case 'accessory':
    default:
      return 'Accessory';
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

function normaliseCategory(value: unknown): ClothingTag['category'] {
  if (typeof value !== 'string') return 'top';
  return VALID_CATEGORIES.includes(value as ClothingTag['category'])
    ? (value as ClothingTag['category'])
    : 'top';
}

function sanitizeClothingTag(
  raw: RawClothingTag,
  categoryHint?: ClothingTag['category'],
): ClothingTag {
  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.62;
  let needsReview = false;

  let category = normaliseCategory(raw.category);
  if (categoryHint && VALID_CATEGORIES.includes(categoryHint)) {
    const weakCategories: ClothingTag['category'][] = ['accessory', 'bag'];
    if (weakCategories.includes(category) && !weakCategories.includes(categoryHint)) {
      category = categoryHint;
      confidence = Math.max(confidence, 0.72);
    }
  }

  let name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || containsBannedUndergarmentTerm(name)) {
    name = defaultNameForCategory(category);
    confidence = Math.min(confidence, 0.45);
    needsReview = true;
  }

  const colors = toStringArray(raw.colors).slice(0, 4);
  const occasions = toStringArray(raw.occasions)
    .map((v) => v.toLowerCase())
    .filter((v) => VALID_OCCASIONS.includes(v))
    .slice(0, 4);
  const seasons = toStringArray(raw.seasons)
    .map((v) => v.toLowerCase())
    .filter((v) => VALID_SEASONS.includes(v))
    .slice(0, 4);
  const tags = toStringArray(raw.tags)
    .filter((v) => !containsBannedUndergarmentTerm(v))
    .slice(0, 8);

  const styleRaw = typeof raw.style === 'string' ? raw.style.toLowerCase() : '';
  const style = VALID_STYLES.includes(styleRaw as ClothingTag['style'])
    ? (styleRaw as ClothingTag['style'])
    : 'casual';

  if (styleRaw && !VALID_STYLES.includes(styleRaw as ClothingTag['style'])) {
    confidence = Math.min(confidence, 0.58);
    needsReview = true;
  }

  if (colors.length === 0 || colors[0] === 'unknown') {
    confidence = Math.min(confidence, 0.58);
    needsReview = true;
  }

  if (raw.isUncertain === true) {
    confidence = Math.min(confidence, 0.5);
    needsReview = true;
  }

  if (confidence < 0.7) {
    needsReview = true;
  }

  const brand = typeof raw.brand === 'string' && raw.brand.trim().length > 0
    ? raw.brand.trim()
    : undefined;

  return {
    name,
    category,
    colors: colors.length > 0 ? colors : ['unknown'],
    style,
    occasions: occasions.length > 0 ? occasions : ['casual'],
    seasons: seasons.length > 0 ? seasons : ['spring', 'summer', 'autumn', 'winter'],
    tags,
    brand,
    confidence,
    needsReview,
  };
}

export interface GarmentRegion {
  name: string;
  category: ClothingTag['category'];
  x: number;
  y: number;
  width: number;
  height: number;
}

const VALID_CATEGORIES: ClothingTag['category'][] = [
  'top',
  'bottom',
  'dress',
  'outerwear',
  'shoes',
  'accessory',
  'bag',
];

function normaliseRegion(region: GarmentRegion, imageWidth: number, imageHeight: number): GarmentRegion {
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(region.y)));
  const width = Math.max(32, Math.min(imageWidth - x, Math.round(region.width)));
  const height = Math.max(32, Math.min(imageHeight - y, Math.round(region.height)));

  const category = VALID_CATEGORIES.includes(region.category)
    ? region.category
    : 'accessory';

  return {
    ...region,
    category,
    x,
    y,
    width,
    height,
  };
}

/**
 * Detect separate clothing regions in a photo that may contain multiple items.
 * Returns pixel bounding boxes in the original image coordinate space.
 */
export async function detectGarmentRegions(
  imagePath: string,
  imageWidth: number,
  imageHeight: number,
): Promise<GarmentRegion[]> {
  const model = getGeminiModel();
  const ext = path.extname(imagePath).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
    throw new Error('Only JPEG and PNG images are supported');
  }

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  const mimeType: 'image/png' | 'image/jpeg' = ext === '.png' ? 'image/png' : 'image/jpeg';

  const result = await model.generateContent([
    {
      inlineData: { data: base64Image, mimeType },
    },
    `Identify distinct clothing items in this image. The image size is ${imageWidth}x${imageHeight} pixels.

Return ONLY a JSON array. Each object must use this exact shape:
[
  {
    "name": "short label",
    "category": "top|bottom|dress|outerwear|shoes|accessory|bag",
    "x": 120,
    "y": 90,
    "width": 260,
    "height": 340
  }
]

Rules:
- Include only visible clothing items worth saving to a wardrobe.
- Bounding boxes must be pixel values in this original image coordinate space.
- Do not include person body parts or background objects.
- If only one item is visible, return one object.
- Maximum 6 objects.
- Return JSON only, no markdown or explanations.`,
  ]);

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response for garment detection');
  }

  const raw = parseJsonResponse<GarmentRegion[]>(text);
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  return raw
    .slice(0, 6)
    .filter((region) => Number.isFinite(region.x)
      && Number.isFinite(region.y)
      && Number.isFinite(region.width)
      && Number.isFinite(region.height))
    .map((region) => normaliseRegion(region, imageWidth, imageHeight));
}

/**
 * Analyse a clothing image using Claude Vision and return structured tags.
 * Only JPEG and PNG images are accepted.
 */
export async function tagClothingItem(
  imagePath: string,
  options?: { categoryHint?: ClothingTag['category'] },
): Promise<ClothingTag> {
  const model = getGeminiModel();
  const ext = path.extname(imagePath).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
    throw new Error('Only JPEG and PNG images are supported');
  }

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  const mimeType: 'image/png' | 'image/jpeg' = ext === '.png' ? 'image/png' : 'image/jpeg';

  const result = await model.generateContent([
    {
      inlineData: { data: base64Image, mimeType },
    },
    `Analyse this clothing item and return a JSON object with these exact fields:
{
  "name": "short descriptive name e.g. White linen shirt",
  "category": one of: top | bottom | dress | outerwear | shoes | accessory | bag,
  "colors": ["primary color", "secondary color if any"],
  "style": one of: casual | smart | formal | sport | streetwear,
  "occasions": array of: casual | work | evening | formal | sport,
  "seasons": array of: spring | summer | autumn | winter,
  "tags": ["fabric type", "pattern", "fit", "other descriptors"],
  "brand": "brand name if visible or null",
  "confidence": number from 0.0 to 1.0,
  "isUncertain": true or false
}

Safety rules:
- This is a general wardrobe assistant, so avoid undergarment guesses.
- Never use labels like bra, bralette, lingerie, underwear, panties, thong.
- If uncertain, choose a safer general label (e.g. "Top item") and category "top".
- If the image is ambiguous, prefer conservative categories: top, bottom, dress, outerwear, shoes, accessory, bag.

${options?.categoryHint ? `Likely category hint from prior detection: ${options.categoryHint}. Use this hint unless image clearly contradicts it.` : ''}

Return ONLY the JSON, no explanation.`,
  ]);

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  const parsed = parseJsonResponse<RawClothingTag>(text);
  return sanitizeClothingTag(parsed, options?.categoryHint);
}

export interface OutfitSuggestion {
  name: string;
  itemIds: string[];
  rationale: string;
}

interface WardrobeItem {
  id: string;
  name: string;
  category: string;
  colors: string[];
  style: string;
  occasions: string[];
  seasons: string[];
  tags: string[];
  lastWornAt?: string;
}

/**
 * Generate weather- and occasion-aware outfit suggestions using Claude.
 */
export async function generateOutfitSuggestions(params: {
  occasion: string;
  weather: { temp: number; condition: string };
  wardrobe: WardrobeItem[];
}): Promise<OutfitSuggestion[]> {
  const model = getGeminiModel();
  const { occasion, weather, wardrobe } = params;

  const wardrobeSummary = wardrobe.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    colors: item.colors,
    style: item.style,
    occasions: item.occasions,
    lastWornAt: item.lastWornAt,
  }));

  const result = await model.generateContent(
    `You are a personal stylist. Generate 3 outfit suggestions from this wardrobe.

Occasion: ${occasion}
Weather: ${weather.temp}°C, ${weather.condition}
Wardrobe: ${JSON.stringify(wardrobeSummary, null, 2)}

Rules:
- Each outfit needs at least a top + bottom (or dress)
- Match weather appropriately
- Prioritise items not worn recently (lastWornAt is older or null)
- Items must actually be in the wardrobe (use real IDs)
- Consider colour coordination

Return ONLY a JSON array of 3 outfits:
[
  {
    "name": "Short outfit name",
    "itemIds": ["id1", "id2", "id3"],
    "rationale": "One line explaining why this works"
  }
]`,
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<OutfitSuggestion[]>(text);
}

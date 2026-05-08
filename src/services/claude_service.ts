import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';

function getGeminiModel(modelName = 'gemini-flash-latest'): ReturnType<GoogleGenerativeAI['getGenerativeModel']> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
}

function parseJsonResponse<T>(rawText: string): T {
  try {
    const jsonMatch = rawText.match(/```json([\s\S]*?)```/);
    const clean = jsonMatch ? jsonMatch[1].trim() : rawText.replace(/```json|```/g, '').trim();
    // Also remove any text before the first { or [
    const firstBrace = clean.indexOf('{');
    const firstBracket = clean.indexOf('[');
    const startIndex = (firstBrace !== -1 && firstBracket !== -1) 
      ? Math.min(firstBrace, firstBracket) 
      : Math.max(firstBrace, firstBracket);
    
    if (startIndex !== -1) {
      const lastBrace = clean.lastIndexOf('}');
      const lastBracket = clean.lastIndexOf(']');
      const endIndex = Math.max(lastBrace, lastBracket) + 1;
      return JSON.parse(clean.substring(startIndex, endIndex)) as T;
    }
    return JSON.parse(clean) as T;
  } catch (error) {
    console.error('Failed to parse Gemini JSON:', rawText);
    throw error;
  }
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
  perfume?: string;
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
  styleProfile?: {
    skinTone: string;
    undertone: string;
    contrast: string;
    gender: string;
  };
}): Promise<OutfitSuggestion[]> {
  const model = getGeminiModel();
  const { occasion, weather, wardrobe, styleProfile } = params;

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
${styleProfile ? `Style profile: ${JSON.stringify(styleProfile, null, 2)}` : ''}

Rules:
- Each outfit needs at least a top + bottom (or dress)
- Match weather appropriately
- Prioritise items not worn recently (lastWornAt is older or null)
- Items must actually be in the wardrobe (use real IDs)
- Consider colour coordination
- Ensure color and contrast choices flatter the style profile when provided
- Recommend a suitable perfume/cologne fragrance profile (e.g. "A fresh citrus scent", "A warm woody cologne") that matches the outfit, weather, and occasion.

Return ONLY a JSON array of 3 outfits:
[
  {
    "name": "Short outfit name",
    "itemIds": ["id1", "id2", "id3"],
    "rationale": "One line explaining why this works",
    "perfume": "A short description of a recommended fragrance profile"
  }
]`,
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<OutfitSuggestion[]>(text);
}

export interface TripPlan {
  packingList: string[];
  dailyOutfits: {
    day: number;
    date: string;
    name: string;
    itemIds: string[];
    rationale: string;
    perfume?: string;
  }[];
}

/**
 * Generate a smart packing list and daily itinerary using Claude.
 */
export async function generateTripPlan(params: {
  destination: string;
  startDate: string;
  endDate: string;
  purpose: string;
  wardrobe: WardrobeItem[];
  styleProfile?: {
    skinTone: string;
    undertone: string;
    contrast: string;
    gender: string;
  };
}): Promise<TripPlan> {
  const model = getGeminiModel();
  const { destination, startDate, endDate, purpose, wardrobe, styleProfile } = params;

  const wardrobeSummary = wardrobe.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    colors: item.colors,
    style: item.style,
    occasions: item.occasions,
  }));

  const result = await model.generateContent(
    `You are a luxury travel stylist. The user is traveling to ${destination} from ${startDate} to ${endDate}.
The purpose of the trip is: ${purpose}.
Their available wardrobe is: ${JSON.stringify(wardrobeSummary, null, 2)}
${styleProfile ? `Style profile: ${JSON.stringify(styleProfile, null, 2)}` : ''}

Rules:
1. Infer the typical weather for ${destination} during these dates.
2. Select a versatile, minimalist capsule wardrobe from their available items (packingList). Prioritize items that can be mixed and matched.
3. Generate exactly one outfit per day of the trip.
4. Each outfit MUST ONLY use items included in the packingList.
5. Provide a short rationale for why the outfit works for that day's assumed weather and activities.
6. Suggest a daily perfume/cologne fragrance profile.

Return ONLY a JSON object matching this schema:
{
  "packingList": ["item_id_1", "item_id_2"],
  "dailyOutfits": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "name": "Travel & Check-in",
      "itemIds": ["item_id_1", "item_id_2"],
      "rationale": "Comfortable layers for travel.",
      "perfume": "A light, fresh citrus scent."
    }
  ]
}`
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<TripPlan>(text);
}

/**
 * Generate 3 outfits that prominently feature a specific, neglected clothing item.
 */
export async function generateStylingChallenge(params: {
  targetItem: WardrobeItem;
  wardrobe: WardrobeItem[];
  weather?: { temp: number; condition: string };
}): Promise<OutfitSuggestion[]> {
  const model = getGeminiModel();
  const { targetItem, wardrobe, weather } = params;

  const wardrobeSummary = wardrobe.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    colors: item.colors,
    style: item.style,
  }));

  const weatherContext = weather 
    ? `Current Weather: ${weather.temp}°C, ${weather.condition}`
    : `Assume comfortable, temperate weather.`;

  const result = await model.generateContent(
    `You are a personal stylist. The user wants to wear a neglected item from their closet:
Target Item: ${targetItem.name} (Category: ${targetItem.category}, Colors: ${targetItem.colors.join(', ')})

${weatherContext}
Available Wardrobe: ${JSON.stringify(wardrobeSummary, null, 2)}

Rules:
1. Generate exactly 3 fresh outfit ideas.
2. EVERY outfit MUST include the Target Item (id: "${targetItem.id}").
3. Include at least a top and bottom (or dress) to make a complete outfit.
4. Only use items from the available wardrobe.

Return ONLY a JSON array of 3 outfits matching this schema:
[
  {
    "name": "Short, catchy outfit name",
    "itemIds": ["id1", "id2", "${targetItem.id}"],
    "rationale": "Why this combination makes the target item look great."
  }
]`
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<OutfitSuggestion[]>(text);
}

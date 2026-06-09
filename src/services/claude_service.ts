import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';

function getGeminiModel(
  modelName = 'gemini-2.5-flash',
  generationConfig?: any
): ReturnType<GoogleGenerativeAI['getGenerativeModel']> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig,
  });
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
  const model = getGeminiModel('gemini-2.5-flash', { temperature: 1.0 });
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

  const randomSeed = Math.random().toString(36).substring(7);
  const currentTime = new Date().toISOString();

  const result = await model.generateContent(
    `You are a personal stylist. Generate 3 outfit suggestions from this wardrobe.

Random seed for styling variety: ${randomSeed} (Generated at: ${currentTime})
Instruction: Use this seed to introduce creative variety. Try different color combinations, styles, and themes than before. Surprise the user with fresh, creative matches!

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

export interface TripPlan {
  packingList: string[];
  dailyOutfits: any[];
  suggestedAdditions: Array<{
    name: string;
    category: string;
    reason: string;
  }>;
}

/**
 * Generate a trip plan using Claude/Gemini.
 */
export async function generateTripPlan(params: {
  destination: string;
  startDate: string;
  endDate: string;
  purpose: string;
  wardrobe: any[];
  homeCity?: string;
  styleProfile?: any;
}): Promise<TripPlan> {
  const model = getGeminiModel();
  const { destination, startDate, endDate, purpose, wardrobe, homeCity, styleProfile } = params;

  const styleContext = styleProfile
    ? `The user's personal style profile:
- Skin Tone / Undertone: ${styleProfile.skinTone ?? 'unknown'} (${styleProfile.undertone ?? 'unknown'} undertone)
- Contrast Level: ${styleProfile.contrast ?? 'unknown'}
- Dressing Preference / Gender Expression: ${styleProfile.gender ?? 'unknown'}
- Style Aesthetic: Sophisticated, harmonized color coordination, structured and high-quality styling.`
    : '';

  const homeCityContext = homeCity
    ? `The user is traveling from their home city of ${homeCity} to the destination city of ${destination}.
Because they are traveling between these two cities, they will encounter the weather in both locations on their departure and return travel days.
You MUST pack and suggest items (e.g., versatile layers, comfortable travel transit outfits) that cater for the climates in BOTH ${homeCity} and ${destination}, ensuring comfortable transit and seamless styling across both cities.`
    : '';

  const result = await model.generateContent(
    `You are an elite high-end celebrity personal stylist and luxury wardrobe consultant. You are designing a highly sophisticated, stylish, and curated capsule wardrobe trip plan to ${destination} from ${startDate} to ${endDate} for a ${purpose} trip.

${homeCityContext}

${styleContext}

User's Existing Wardrobe Items:
${JSON.stringify(wardrobe, null, 2)}

Your styling instructions are:
1. **Sophistication & Cohesion**: Do not recommend generic or basic outfits. Design highly cohesive, fashionable, and aesthetic looks that match the local climate and fashion culture of ${destination} for the purpose of a ${purpose} trip.
2. **Personalized Color Theory**: Utilize the user's style profile (especially skin tone, undertone, and contrast level) to choose flattering garment colors from their wardrobe. Match warm undertones with earth/warm tones, cool undertones with cool/jewel tones, and contrast level for bold vs. monochromatic coordination.
3. **Daily Outfits**: For each day of the trip, curate a complete stylish daily outfit using items from the wardrobe. Ensure the color coordination and silhouette are highly elegant. Provide a clear, stylish, and professional 'rationale' explaining the styling synergy, color theory, and why the look is perfect for the destination's vibe.
4. **Suggested Additions**: Recommend 1 to 3 items that are NOT in their wardrobe but are absolute must-haves to elevate their looks and complete their travel wardrobe. Provide highly specific styling advice for each suggestion, describing exactly how it coordinates with their existing wardrobe items to create high-end, elegant outfits.

Return ONLY a JSON object with this exact shape:
{
  "packingList": ["id1", "id2"],
  "dailyOutfits": [
    {
      "day": 1,
      "outfit": {
        "name": "E.g., Casual Parisian Chic",
        "itemIds": ["id1"],
        "rationale": "Styling rationale explaining the color harmony and silhouette synergy for the day's events."
      }
    }
  ],
  "suggestedAdditions": [
    {
      "name": "E.g., Beige Linen Blazer",
      "category": "outerwear",
      "reason": "An elegant layering piece that adds structured sophistication. Elevates your daily denim look and matches perfectly with your white shirt."
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

export interface StoreItemMatch {
  clothingItemId: string;
  rationale: string;
}

/**
 * Find matching closet items that coordinate beautifully with a retail store item.
 */
export async function generateStoreItemMatches(params: {
  storeItem: {
    name: string;
    category: string;
    colors: string[];
    style: string;
    occasions: string[];
    seasons: string[];
    tags: string[];
  };
  wardrobe: any[];
}): Promise<StoreItemMatch[]> {
  const model = getGeminiModel('gemini-2.5-flash', { temperature: 0.7 });
  const { storeItem, wardrobe } = params;

  const wardrobeSummary = wardrobe.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    colors: JSON.parse(item.colors),
    style: item.style,
    occasions: JSON.parse(item.occasions),
    tags: JSON.parse(item.tags),
  }));

  const result = await model.generateContent(
    `You are a personal stylist. A user is in a store and took a picture of a potential new clothing item they want to buy.
    
Store Item details:
${JSON.stringify(storeItem, null, 2)}

User's Existing Wardrobe:
${JSON.stringify(wardrobeSummary, null, 2)}

Select the top 3 best matching items from their existing wardrobe that would work perfectly with this new store item to create stylish outfits.

For each of the 3 matching items, explain briefly (one clear sentence) why they coordinate well together (color matching, style harmony, layering options, etc.).

Return ONLY a JSON array of the top 3 matches:
[
  {
    "clothingItemId": "closet-item-id-1",
    "rationale": "One sentence explaining why this matches the new store item."
  }
]`
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<StoreItemMatch[]>(text);
}

/**
 * Generate 3 outfits that prominently feature a specific, neglected clothing item.
 */
export async function generateStylingChallenge(params: {
  targetItem: {
    id: string;
    name: string;
    category: string;
    colors: string[];
    style: string;
    occasions: string[];
    seasons: string[];
    tags: string[];
  };
  wardrobe: any[];
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
    `You are an expert personal stylist. The user wants to wear a neglected item from their closet:
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

export interface WeeklyOutfitDay {
  day: string;
  weatherSimulated: { temp: number; condition: string };
  outfit: {
    name: string;
    itemIds: string[];
    rationale: string;
  };
}

/**
 * Generate a coordinated 7-day capsule wardrobe outfit plan.
 */
export async function generateWeeklyOutfitPlanner(params: {
  occasion: string;
  weather: { temp: number; condition: string };
  wardrobe: WardrobeItem[];
  styleProfile?: {
    skinTone: string;
    undertone: string;
    contrast: string;
    gender: string;
  };
}): Promise<WeeklyOutfitDay[]> {
  const model = getGeminiModel('gemini-2.5-flash', {
    temperature: 0.8,
    responseMimeType: 'application/json',
  });
  const { occasion, weather, wardrobe, styleProfile } = params;

  // Pre-filter wardrobe to the requested occasion to shrink prompt size and speed up reasoning
  let filteredWardrobe = wardrobe.filter((item) => {
    if (!item.occasions || item.occasions.length === 0) return true;
    return item.occasions.includes(occasion);
  });

  // Fallback: Ensure the model has enough items to generate a 7-day rotation
  if (filteredWardrobe.length < 8) {
    filteredWardrobe = wardrobe;
  }

  const wardrobeSummary = filteredWardrobe.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    colors: item.colors,
    style: item.style,
    lastWornAt: item.lastWornAt,
  }));

  const result = await model.generateContent(
    `You are a personal stylist and coordinated capsule wardrobe planner. Design a coordinated 7-day capsule planner for the upcoming week (Monday through Sunday) for the selected occasion.

Baseline Weather: ${weather.temp}°C, ${weather.condition}
Selected Occasion: ${occasion}
Wardrobe: ${JSON.stringify(wardrobeSummary, null, 2)}
${styleProfile ? `Style profile: ${JSON.stringify(styleProfile, null, 2)}` : ''}

Instructions and Rules:
1. **Weather Simulation**: Generate/simulate a realistic weather forecast for each of the 7 days (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday) starting from the baseline weather of ${weather.temp}°C and condition "${weather.condition}" (allow minor realistic temperature fluctuations, e.g. ±3°C, and varying conditions like partly cloudy, sunny, light rain, clear).
2. **Coordinated Rotation**: Plan a cohesive 7-day outfit sequence. Ensure that key pieces are rotated beautifully. Avoid repeating the exact same outfit. Show capsule versatility by mixing and matching!
3. **Completeness**: Each outfit must contain at least a top + bottom (or dress) to make a complete look, suitable for the simulated weather of that day and the occasion.
4. **Existing Wardrobe Only**: Use ONLY the item IDs present in the user's wardrobe.
5. **Style Harmony**: Ensure color and style choices flatter the style profile if provided.
6. **Selection Awareness**: Prioritize styling items that have not been worn recently (based on the "lastWornAt" timestamp) to optimize closet utility and rotate user selections intelligently.

Return ONLY a JSON array of 7 objects (one for each day, Monday to Sunday) using this exact schema:
[
  {
    "day": "Monday",
    "weatherSimulated": {
      "temp": 21.5,
      "condition": "Partly Cloudy"
    },
    "outfit": {
      "name": "Catchy outfit name",
      "itemIds": ["id1", "id2"],
      "rationale": "Extremely concise rationale (maximum 12 words) explaining why this outfit is perfect."
    }
  }
]

Return JSON only, no markdown formatting or extra text.`
  );

  const text = result.response.text();
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return parseJsonResponse<WeeklyOutfitDay[]>(text);
}


import { PrismaClient } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const prisma = new PrismaClient();
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('GEMINI_API_KEY is not defined in backend/.env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function tagImageFromUrl(imageUrl: string) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const buffer = Buffer.from(response.data);
    const base64Data = buffer.toString('base64');
    const mimeType = imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Analyse this clothing item image and return ONLY a JSON object with these exact fields:
{
  "name": "short descriptive name e.g. Navy Blue Cotton T-Shirt",
  "category": "top" | "bottom" | "dress" | "outerwear" | "shoes" | "accessory" | "bag",
  "colors": ["blue", "white"],
  "style": "casual" | "smart" | "formal" | "sport" | "streetwear",
  "occasions": ["casual", "work"],
  "seasons": ["spring", "summer", "autumn", "winter"],
  "tags": ["cotton", "t-shirt"]
}`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: base64Data,
        },
      },
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/```json([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    const cleanJson = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
    const parsed = JSON.parse(cleanJson.trim());

    return {
      name: parsed.name || 'Garment Item',
      category: ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory', 'bag'].includes(parsed.category) ? parsed.category : 'top',
      colors: Array.isArray(parsed.colors) ? parsed.colors : ['unknown'],
      style: ['casual', 'smart', 'formal', 'sport', 'streetwear'].includes(parsed.style) ? parsed.style : 'casual',
      occasions: Array.isArray(parsed.occasions) ? parsed.occasions : ['casual'],
      seasons: Array.isArray(parsed.seasons) ? parsed.seasons : ['spring', 'summer'],
      tags: Array.isArray(parsed.tags) ? parsed.tags : ['clothing'],
    };
  } catch (err: any) {
    console.error(`AI tagging failed for ${imageUrl}:`, err.message || err);
    return {
      name: 'Garment Item',
      category: 'top',
      colors: ['neutral'],
      style: 'casual',
      occasions: ['casual'],
      seasons: ['spring', 'summer'],
      tags: ['wardrobe'],
    };
  }
}

async function recover() {
  console.log('🚀 Starting Wardrobe Auto-Recovery from Supabase Storage...');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://fzohfxdoyoxvujvovqvw.supabase.co';

  // 1. Fetch all storage objects in wardrobe-images bucket
  const objects: any[] = await prisma.$queryRaw`SELECT id, name, created_at FROM storage.objects WHERE bucket_id = 'wardrobe-images' ORDER BY created_at ASC`;
  console.log(`📦 Found ${objects.length} total storage objects in Supabase.`);

  // Group objects by unique base file ID
  // e.g., '242de8ff-40ae-49f1-9dfd-da210bc9f0b3_full.png' vs '242de8ff-40ae-49f1-9dfd-da210bc9f0b3.png'
  const garmentMap = new Map<string, { fullUrl?: string; rawUrl?: string; createdAt: Date }>();

  for (const obj of objects) {
    const filename: string = obj.name;
    const isFull = filename.includes('_full');
    const baseId = filename.replace('_full', '').replace(/\.(png|jpg|jpeg|webp)$/i, '');
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/wardrobe-images/${filename}`;

    if (!garmentMap.has(baseId)) {
      garmentMap.set(baseId, { createdAt: new Date(obj.created_at) });
    }

    const entry = garmentMap.get(baseId)!;
    if (isFull) {
      entry.fullUrl = publicUrl;
    } else {
      entry.rawUrl = publicUrl;
    }
  }

  const garmentsToRecover = Array.from(garmentMap.entries()).map(([baseId, data]) => ({
    id: baseId,
    imageUrl: data.fullUrl || data.rawUrl!,
    addedAt: data.createdAt,
  }));

  console.log(`✨ Identified ${garmentsToRecover.length} distinct garment items to restore!`);

  // 2. Identify or ensure target user accounts
  // Target user IDs from users.json and database
  const targetEmails = [
    'tflux2011@gmail.com',
    'tobi.adeosun004@gmail.com',
    'tadeosun004@gmail.com',
  ];

  const targetUsers: { id: string; email: string }[] = [];

  for (const email of targetEmails) {
    let user = await prisma.user.findFirst({ where: { email } });
    if (!user) {
      // Find from users.json if present
      const usersJsonPath = path.join(__dirname, '../../../flutter/users.json');
      if (fs.existsSync(usersJsonPath)) {
        const fileContent = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
        const found = (fileContent.users || []).find((u: any) => u.email === email);
        if (found && found.localId) {
          user = await prisma.user.create({
            data: {
              id: found.localId,
              email: email,
              fullName: 'Tobi Adeosun',
            },
          });
          console.log(`Created user record for ${email} with ID ${user.id}`);
        }
      }
    }
    if (user) {
      targetUsers.push({ id: user.id, email: user.email || email });
    }
  }

  console.log(`👤 Target user accounts to populate:`, targetUsers);

  if (targetUsers.length === 0) {
    console.error('No target users found in DB!');
    return;
  }

  // 3. Iterate through garments and restore to target users
  let restoredCount = 0;
  const batchSize = 5;

  for (let i = 0; i < garmentsToRecover.length; i += batchSize) {
    const chunk = garmentsToRecover.slice(i, i + batchSize);
    console.log(`🔄 Processing garments ${i + 1} to ${Math.min(i + batchSize, garmentsToRecover.length)} of ${garmentsToRecover.length}...`);

    await Promise.all(
      chunk.map(async (garment) => {
        try {
          const tags = await tagImageFromUrl(garment.imageUrl);

          // Insert into database for ALL target user accounts so clothes appear regardless of which account is logged in!
          for (const user of targetUsers) {
            const itemId = `${garment.id}_${user.id.substring(0, 5)}`;
            
            await prisma.clothingItem.upsert({
              where: { id: itemId },
              update: {
                name: tags.name,
                category: tags.category,
                style: tags.style,
                colors: JSON.stringify(tags.colors),
                occasions: JSON.stringify(tags.occasions),
                seasons: JSON.stringify(tags.seasons),
                tags: JSON.stringify(tags.tags),
                imageUrl: garment.imageUrl,
              },
              create: {
                id: itemId,
                userId: user.id,
                name: tags.name,
                category: tags.category,
                style: tags.style,
                colors: JSON.stringify(tags.colors),
                occasions: JSON.stringify(tags.occasions),
                seasons: JSON.stringify(tags.seasons),
                tags: JSON.stringify(tags.tags),
                imageUrl: garment.imageUrl,
                localImagePath: '',
                addedAt: garment.addedAt,
              },
            });
          }
          restoredCount++;
        } catch (err: any) {
          console.error(`Failed to restore garment ${garment.id}:`, err.message || err);
        }
      })
    );
  }

  console.log(`🎉 SUCCESS! Restored ${restoredCount} clothing items across target user accounts!`);
}

recover()
  .catch((e) => console.error('Recovery failed:', e))
  .finally(() => prisma.$disconnect());

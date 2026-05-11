import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase URL or Service Role Key in environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

import * as fs from 'fs';
import * as path from 'path';

/**
 * Uploads a local file to the Supabase Storage 'wardrobe-images' bucket.
 * Returns the public URL of the uploaded image.
 */
export async function uploadLocalFileToSupabase(localFilePath: string, filename: string): Promise<string> {
  const fileBuffer = fs.readFileSync(localFilePath);
  return uploadBufferToSupabase(fileBuffer, filename);
}

export async function uploadBufferToSupabase(fileBuffer: Buffer, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  let contentType = 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  else if (ext === '.webp') contentType = 'image/webp';

  const { data, error } = await supabase.storage
    .from('wardrobe-images')
    .upload(filename, fileBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload to Supabase: ${error.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from('wardrobe-images')
    .getPublicUrl(data.path);

  return publicUrlData.publicUrl;
}

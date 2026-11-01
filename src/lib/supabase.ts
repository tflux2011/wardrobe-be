import { createClient } from '@supabase/supabase-js';

let client:ReturnType<typeof createClient>|undefined;
function getClient(){
 if(!client){
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!key)throw new Error('Missing server storage configuration');
  client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 }
 return client;
}
export const supabase=new Proxy({} as ReturnType<typeof createClient>,{get:(_target,key)=>{
 const instance=getClient();const value=Reflect.get(instance,key);return typeof value==='function'?value.bind(instance):value;
}});

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

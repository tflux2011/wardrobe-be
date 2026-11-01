import 'dotenv/config';
import assert from 'node:assert/strict';
import {prisma} from '../lib/prisma';
import {mediaLink} from '../services/media';
import {supabase} from '../lib/supabase';
(async()=>{
 const asset=await prisma.mediaAsset.findFirstOrThrow({where:{ready:true,legacyUrl:{not:null}}});
 const base='https://wardrobe-be-fzoh.onrender.com';
 const old=await fetch(asset.legacyUrl!,{method:'HEAD'});assert.notEqual(old.status,200);
 const unsigned=await fetch(`${base}/media/${asset.id}`,{method:'HEAD',redirect:'manual'});assert.equal(unsigned.status,403);
 const other=await fetch(base+mediaLink(`/media/${asset.id}`,'security-unrelated-account'),{method:'HEAD',redirect:'manual'});assert.equal(other.status,404);
 const own=await fetch(base+mediaLink(`/media/${asset.id}`,asset.userId),{method:'HEAD',redirect:'manual'});assert.equal(own.status,302);
 const location=own.headers.get('Location')!;const download=await fetch(location,{method:'HEAD'});assert.equal(download.status,200);
 const permissions=await prisma.$queryRaw<Array<{clothes:boolean;users:boolean;media:boolean}>>`SELECT has_table_privilege('anon','"ClothingItem"','SELECT') AS clothes,has_table_privilege('anon','"User"','SELECT') AS users,has_table_privilege('anon','"MediaAsset"','SELECT') AS media`;
 assert.deepEqual(permissions,[{clothes:false,users:false,media:false}]);
 for(const name of ['wardrobe-images','clad-private']){const {data,error}=await supabase.storage.getBucket(name);assert.equal(error,null);assert.equal(data?.public,false);}
 assert.equal(await prisma.clothingItem.count({where:{NOT:{imageUrl:{startsWith:'/media/'}}}}),0);
 console.log('PASS: old public URLs blocked; unsigned media denied; cross-account media denied; valid signed photo accessible; direct anonymous DB access denied; both buckets private; all wardrobe references migrated.');
})().catch(()=>{console.error('Private release verification failed. Inspect access checks before launch.');process.exitCode=1;}).finally(()=>prisma.$disconnect());

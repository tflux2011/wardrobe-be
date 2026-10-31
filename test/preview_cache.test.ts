import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreviewCache} from '../src/services/preview_cache';
test('front returns without a back edit; repeats reuse the saved view',async()=>{
 const cache=new PreviewCache();let calls=0;
 const make=async()=>{calls++;return {imageUrl:'/front.png',mimeType:'image/png'};};
 const [a,b]=await Promise.all([cache.generate('user-a:shirt','front',make),cache.generate('user-a:shirt','front',make)]);
 assert.equal(calls,1);assert.equal(a.previewId,b.previewId);
 await cache.generate('user-a:shirt','front',make);assert.equal(calls,1);
 await cache.generate('user-b:shirt','front',make);assert.equal(calls,2);
});
test('back requires a matching front and failed edits can be retried',async()=>{
 const cache=new PreviewCache();
 await assert.rejects(cache.generate('a','back',async()=>{throw Error('must not run');}),/FRONT_PREVIEW_EXPIRED/);
 const front=await cache.generate('a','front',async()=>({imageUrl:'/front.png',mimeType:'image/png'}));
 await assert.rejects(cache.generate('a','back',async()=>{throw Error('must not run');},'wrong-id'),/FRONT_PREVIEW_EXPIRED/);
 await assert.rejects(cache.generate('a','back',async()=>{throw Error('Temporary failure');},front.previewId),/Temporary failure/);
 const back=await cache.generate('a','back',async original=>{assert.equal(original?.imageUrl,'/front.png');return {imageUrl:'/back.png',mimeType:'image/png'};},front.previewId);
 assert.equal(back.back?.imageUrl,'/back.png');assert.equal(cache.get('a')?.front?.imageUrl,'/front.png');
});

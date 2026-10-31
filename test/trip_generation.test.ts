import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateValidatedTrip, tripWardrobeReferences, TripGenerationError} from '../src/services/trip_generation';
const plan = (id: string) => ({packingList:[id], dailyOutfits:[{day:1,outfit:{name:'A look',itemIds:[id],rationale:'Travel'}}]});
test('invalid generated references are retried before returning a saveable trip',async()=>{
 const attempts:boolean[]=[];
 const result=await generateValidatedTrip(async(repair)=>{attempts.push(repair);return plan(repair?'owned':'invented');},['owned'],1);
 assert.deepEqual(attempts,[false,true]);assert.deepEqual(result.packingList,['owned']);
});
test('repeated invalid plans fail explicitly instead of saving invented garments',async()=>{
 await assert.rejects(generateValidatedTrip(async()=>plan('invented'),['owned'],1),TripGenerationError);
});
test('short references restore packing, outfits and idea pairings without legitimizing invented IDs',()=>{
 const refs=tripWardrobeReferences([{id:'long-real-id',name:'Shirt'}]);
 assert.equal(refs.wardrobe[0].id,'piece_1');
 const result=refs.restore({...plan('piece_1'),suggestedAdditions:[{pairWithItemIds:['piece_1','unknown']} ]});
 assert.deepEqual(result.packingList,['long-real-id']);assert.deepEqual(result.dailyOutfits[0].outfit.itemIds,['long-real-id']);
 assert.deepEqual(result.suggestedAdditions[0].pairWithItemIds,['long-real-id','unknown']);
});

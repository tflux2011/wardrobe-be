import {test} from 'node:test';import assert from 'node:assert/strict';
import {rotationCandidates} from '../src/services/wardrobe_rotation';
test('recent pieces rest only when alternatives in the same category exist',()=>{
 const now=new Date('2026-10-31T12:00:00Z');const items=[{id:'recent',category:'top',lastWornAt:now},{id:'rested',category:'top',lastWornAt:null},{id:'only-shoes',category:'shoes',lastWornAt:now}];
 assert.deepEqual(rotationCandidates(items,3,now).map(item=>item.id),['rested','only-shoes']);assert.equal(rotationCandidates(items,0,now).length,3);
});

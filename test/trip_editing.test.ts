import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packingAfterDayChange,dayChange} from '../src/services/trip_editing';
import {travelDetailsSchema} from '../src/services/trip_validation';
test('swapping a piece preserves shared pieces and intentional packing extras',()=>{
 const previous=[{outfit:{itemIds:['shirt','pants']}},{outfit:{itemIds:['shirt','shoes']}}];
 const next=[{outfit:{itemIds:['new-shirt','pants']}},previous[1]];
 assert.deepEqual(new Set(packingAfterDayChange(previous,next,['shirt','pants','shoes','raincoat'])),new Set(['raincoat','new-shirt','pants','shirt','shoes']));
});
test('unused old pieces leave the packing list after repair',()=>{
 assert.deepEqual(packingAfterDayChange([{itemIds:['missing']}],[{outfit:{itemIds:['owned']}}],['missing']),['owned']);
});
test('day edits reject empty or unsupported requests',()=>{
 assert.equal(dayChange.safeParse({}).success,false);assert.equal(dayChange.safeParse({itemIds:[]}).success,false);
 assert.equal(dayChange.safeParse({occasion:'Dinner'}).success,true);assert.equal(dayChange.safeParse({occasion:'Anything'}).success,false);
});
test('transport and luggage selections are bounded and validated',()=>{
 assert.equal(travelDetailsSchema.safeParse({transport:'Flying',luggage:['Carry-on','Personal item']}).success,true);
 assert.equal(travelDetailsSchema.safeParse({transport:'Car',luggage:['Arbitrary text']}).success,false);
});

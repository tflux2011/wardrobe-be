import {test} from 'node:test';import assert from 'node:assert/strict';import {validateBuildGuidance} from '../src/services/build_guidance';
import {travelDetailsSchema,validateTripPlan} from '../src/services/trip_validation';
test('unclear build photos cannot save a confident body label or arbitrary fields',()=>{
 const result=validateBuildGuidance({clear:false,proportions:'Defined waist',guidance:'Use a clear full-body photo.',weight:70});assert.equal(result.proportions,'Not clear');assert.equal('weight' in result,false);
 assert.throws(()=>validateBuildGuidance({clear:true,proportions:'Unknown category',guidance:'Something'}));
});
test('piece targets are bounded and plans cannot silently exceed the selected target',()=>{
 assert.equal(travelDetailsSchema.safeParse({transport:'Car',luggage:[],maxPieces:4}).success,false);
 const plan={packingList:['a','b'],dailyOutfits:[{day:1,outfit:{name:'A look',itemIds:['a','b'],rationale:''}}]};
 assert.throws(()=>validateTripPlan(plan,['a','b'],1,1),/packing target/);
 assert.equal(validateTripPlan(plan,['a','b'],1,5).packingList.length,2);
});

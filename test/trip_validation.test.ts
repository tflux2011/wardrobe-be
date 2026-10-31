import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripDateRange, validateTripPlan } from '../src/services/trip_validation';

test('calendar dates do not shift with offsets and inclusive range is correct',()=>{
  const dates=tripDateRange('2026-11-17T00:00:00-06:00','2026-11-20T00:00:00-06:00');
  assert.equal(dates.startDate.toISOString(),'2026-11-17T00:00:00.000Z');
  assert.equal(dates.days,4);
  for(const [start,end] of [['2026-02-30','2026-03-03'],['bad','bad'],['2026-11-20','2026-11-17'],['2026-01-01','2026-12-01']]) assert.throws(()=>tripDateRange(start,end));
});
test('packing includes daily pieces; missing days and invented clothes are rejected',()=>{
  const plan={packingList:['shirt'],dailyOutfits:[{day:1,outfit:{name:'A look',itemIds:['shirt','pants'],rationale:'Layers'}}],suggestedAdditions:[]};
  assert.deepEqual(validateTripPlan(plan,['shirt','pants'],1).packingList,['shirt','pants']);
  assert.throws(()=>validateTripPlan(plan,['shirt'],1));
  assert.throws(()=>validateTripPlan(plan,['shirt','pants'],2));
});

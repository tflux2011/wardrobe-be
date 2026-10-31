import { z } from 'zod';

export const travelDetailsSchema=z.object({transport:z.enum(['Not decided','Flying','Train','Car','Bus','Other']),maxPieces:z.number().int().min(5).max(60).optional(),luggage:z.array(z.enum(['Personal item','Carry-on','Checked suitcase','Backpack','Weekend bag'])).max(5)});

export const tripRequestSchema = z.object({
  travelDetails: travelDetailsSchema.optional(),
  destination: z.string().trim().min(2).max(200),
  homeCity: z.string().trim().max(200).optional(),
  purpose: z.string().trim().min(1).max(500),
  startDate: z.string().max(40), endDate: z.string().max(40),
  styleProfile: z.record(z.unknown()).nullable().optional(),
});

export function tripDateRange(start: string, end: string) {
  const parse = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
    if (!match) throw new Error('Choose valid travel dates.');
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (date.toISOString().slice(0, 10) !== match[0].slice(0, 10)) throw new Error('Choose valid travel dates.');
    return date;
  };
  const startDate = parse(start), endDate = parse(end);
  const days = Math.round((endDate.getTime()-startDate.getTime())/86400000)+1;
  if (days < 1 || days > 30) throw new Error('Choose a trip between 1 and 30 days.');
  return { startDate, endDate, days };
}

const generatedPlanSchema = z.object({
  packingList: z.array(z.string()),
  dailyOutfits: z.array(z.object({day: z.number().int().positive(), outfit: z.object({
    name: z.string().min(1), itemIds: z.array(z.string()).min(1), rationale: z.string(),
  }).passthrough()}).passthrough()),
  suggestedAdditions: z.array(z.object({name: z.string(), category: z.string(), reason: z.string()}).passthrough()).default([]),
});

export function validateTripPlan(value: unknown, ownedIds: string[], days: number, maxPieces?:number) {
  const plan = generatedPlanSchema.parse(value);
  const owned = new Set(ownedIds);
  const daily = [...plan.dailyOutfits].sort((a,b)=>a.day-b.day);
  if (daily.length !== days || daily.some((entry,index)=>entry.day!==index+1)) throw new Error('The trip planner did not return an outfit for every day.');
  const used = daily.flatMap(entry=>entry.outfit.itemIds);
  for(const idea of plan.suggestedAdditions){if(Array.isArray(idea.pairWithItemIds))idea.pairWithItemIds=idea.pairWithItemIds.filter((id:unknown)=>typeof id==='string'&&owned.has(id)).slice(0,3);}
  if ([...plan.packingList, ...used].some(id=>!owned.has(id))) throw new Error('The trip planner referenced clothing outside your closet.');
  const count=new Set([...plan.packingList,...used]).size;
  if(maxPieces && count>maxPieces)throw new Error(`The plan needs more than your ${maxPieces}-piece packing target. Try a higher target or fewer days.`);
  return {...plan, dailyOutfits: daily, packingList: [...new Set([...plan.packingList, ...used])]};
}

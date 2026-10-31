import { z } from 'zod';
export const dayChange=z.object({itemIds:z.array(z.string().min(1)).min(1).max(20).optional(),occasion:z.enum(['Travel','Exploring','Work','Dinner','Relaxing']).optional(),styleProfile:z.record(z.unknown()).optional()}).refine(v=>v.itemIds||v.occasion);
export function packingAfterDayChange(previous:any[],next:any[],packing:string[]):string[]{
  const oldUsed=new Set<string>(previous.flatMap(d=>(d.outfit??d).itemIds??[]));
  const extras=packing.filter(id=>!oldUsed.has(id));
  return [...new Set<string>([...extras,...next.flatMap(d=>(d.outfit??d).itemIds??[])])];
}

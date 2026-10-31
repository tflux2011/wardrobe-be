/** Prefer rested alternatives within each category; never remove its only pieces. */
export function rotationCandidates<T extends {category:string,lastWornAt?:Date|null}>(items:T[],days:number,now=new Date()):T[]{
  const rest=Math.max(0,Math.min(14,Number.isFinite(days)?days:3));
  if(!rest)return items;
  const cutoff=now.getTime()-rest*86400000;
  const freshCategories=new Set(items.filter(item=>!item.lastWornAt||item.lastWornAt.getTime()<=cutoff).map(item=>item.category));
  return items.filter(item=>!freshCategories.has(item.category)||!item.lastWornAt||item.lastWornAt.getTime()<=cutoff);
}

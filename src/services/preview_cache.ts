import { randomUUID } from 'node:crypto';
export type SavedView = { imageUrl: string; mimeType: string };
type Entry = { id: string; expires: number; front?: SavedView; back?: SavedView; pending: Partial<Record<'front'|'back',Promise<SavedView>>> };
/** Keys include the user and every original reference. Never share another user's preview. */
export class PreviewCache {
 private entries=new Map<string,Entry>();
 constructor(private limit=32,private ttl=24*60*60*1000) {}
 get(key:string) {
  const entry=this.entries.get(key);
  if(entry && (entry.expires>Date.now() || Object.keys(entry.pending).length)) return entry;
  this.entries.delete(key);
  return undefined;
 }
 async generate(key:string,view:'front'|'back',create:(front?:SavedView)=>Promise<SavedView>, expectedId?:string) {
  let entry=this.get(key);
  if(view==='back' && (!entry?.front || (expectedId && expectedId!==entry.id))) throw new Error('FRONT_PREVIEW_EXPIRED');
  if(!entry) {
   for(const [k,v] of this.entries) if(!Object.keys(v.pending).length && (this.entries.size>=this.limit || v.expires<=Date.now())) this.entries.delete(k);
   if(this.entries.size>=this.limit) throw new Error('PREVIEW_BUSY');
   entry={id:randomUUID(),expires:Date.now()+this.ttl,pending:{}};this.entries.set(key,entry);
  }
  if(entry[view]) return {previewId:entry.id,[view]:entry[view]};
  if(!entry.pending[view]) {
   const current=entry;
   current.pending[view]=create(current.front).then(value=>{current[view]=value;current.expires=Date.now()+this.ttl;return value;}).finally(()=>{delete current.pending[view];if(!current.front && !current.back)this.entries.delete(key);});
  }
  const result=await entry.pending[view];
  return {previewId:entry.id,[view]:result};
 }
}

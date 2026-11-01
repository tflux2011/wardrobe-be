import type {Request,Response,NextFunction} from 'express';
import fs from 'node:fs';
/** Keep CPU/image buffers bounded, including when a client disconnects mid-request. */
export function workLimit(max=2){
 let running=0;const users=new Set<string>();
 return (handler:(req:Request,res:Response)=>Promise<unknown>)=>async(req:Request,res:Response,next:NextFunction)=>{
  const uid=req.user?.uid||'unknown';
  if(running>=max||users.has(uid)){
   if(req.file)fs.unlink(req.file.path,()=>undefined);
   res.setHeader('Retry-After','5');res.status(429).json({error:'The studio is busy. Please wait a moment and try again.'});return;
  }
  running++;users.add(uid);
  try{await handler(req,res);}catch(error){next(error);}finally{running--;users.delete(uid);}
 };
}

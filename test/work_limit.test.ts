import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {workLimit} from '../src/middleware/work_limit';
test('disconnecting does not release an expensive worker until its work has actually finished',async()=>{
 let begin!:()=>void,finish!:()=>void;
 const begun=new Promise<void>(r=>begin=r),finished=new Promise<void>(r=>finish=r);
 const app=express();app.use((req,_res,next)=>{req.user={uid:'same-user',email:null};next();});
 const guard=workLimit(1);app.get('/',guard(async(_req,res)=>{begin();await finished;res.json({ok:true});}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const controller=new AbortController();const first=fetch(url,{signal:controller.signal}).catch(()=>undefined);await begun;
  controller.abort();await first;
  assert.equal((await fetch(url)).status,429);
  finish();await new Promise(r=>setImmediate(r));
  assert.equal((await fetch(url)).status,200);
 }finally{finish();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

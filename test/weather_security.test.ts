import { fakeUsage } from './usage_fixture';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import axios from 'axios';
import {weatherRouter} from '../src/routes/weather';
test('weather proxy validates coordinates, rounds location, caches results, and never returns provider credentials',async t=>{
 fakeUsage(t);
 const old=process.env.OPENWEATHER_API_KEY;process.env.OPENWEATHER_API_KEY='test-only-weather-key';t.after(()=>{if(old===undefined)delete process.env.OPENWEATHER_API_KEY;else process.env.OPENWEATHER_API_KEY=old;});
 let requests=0;t.mock.method(axios,'get',async(url:string,options:any)=>{
  requests++;assert.equal(url,'https://api.openweathermap.org/data/2.5/weather');assert.equal(options.params.lat,33.06);assert.equal(options.params.lon,-97.02);
  return {data:{main:{temp:20},weather:[{main:'Clear',icon:'01d'}],name:'Lewisville',secret:'not-for-clients'}};
 });
 const app=express();app.use(weatherRouter);const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  assert.equal((await fetch(`${url}/current?lat=91&lon=1`)).status,400);assert.equal(requests,0);
  const good=await fetch(`${url}/current?lat=33.0635358&lon=-97.0164361`);assert.equal(good.status,200);
  const data=await good.json();assert.deepEqual(data,{main:{temp:20},weather:[{main:'Clear',icon:'01d'}],name:'Lewisville'});
  assert.equal((await fetch(`${url}/current?lat=33.0635358&lon=-97.0164361`)).status,200);assert.equal(requests,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

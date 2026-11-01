import { reservePlatformBudget, positiveSetting } from '../services/usage';
import { Router } from 'express';
import axios from 'axios';
import { z } from 'zod';
const query=z.object({lat:z.coerce.number().min(-90).max(90),lon:z.coerce.number().min(-180).max(180)});
const cache=new Map<string,{until:number;value:unknown}>();
export const weatherRouter=Router();
weatherRouter.get('/current',async(req,res)=>{
 const parsed=query.safeParse(req.query);if(!parsed.success)return res.status(400).json({error:'Choose a valid weather location.'});
 const lat=Number(parsed.data.lat.toFixed(2)),lon=Number(parsed.data.lon.toFixed(2)),key=`${lat},${lon}`;
 const existing=cache.get(key);if(existing&&existing.until>Date.now())return res.json(existing.value);
 const apiKey=process.env.OPENWEATHER_API_KEY;if(!apiKey)return res.status(503).json({error:'Weather is temporarily unavailable.'});
 try{
  await reservePlatformBudget('weather',1,positiveSetting('DAILY_PLATFORM_WEATHER_LIMIT',2000));
  const {data}=await axios.get('https://api.openweathermap.org/data/2.5/weather',{params:{lat,lon,appid:apiKey,units:'metric'},timeout:10000,maxContentLength:128*1024});
  const temp=Number(data.main?.temp),condition=String(data.weather?.[0]?.main||''),icon=String(data.weather?.[0]?.icon||'');
  if(!Number.isFinite(temp)||!condition||!/^\d{2}[dn]$/.test(icon))throw Error('Invalid weather');
  const value={main:{temp},weather:[{main:condition,icon}],name:String(data.name||'Nearby').slice(0,120)};
  for(const [id,entry]of cache)if(entry.until<=Date.now())cache.delete(id);
  if(cache.size>=500)cache.delete(cache.keys().next().value!);
  cache.set(key,{until:Date.now()+15*60000,value});return res.json(value);
 }catch{return res.status(502).json({error:'Could not check the weather right now.'});}
});

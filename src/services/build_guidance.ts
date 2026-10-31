import {z} from 'zod';
const guidance=z.object({clear:z.boolean(),proportions:z.enum(['Balanced','Shoulder-led','Hip-led','Defined waist','Straight silhouette','Not clear']),guidance:z.string().min(1).transform(v=>v.slice(0,400))});
export function validateBuildGuidance(value:unknown){const result=guidance.parse(value);return {...result,proportions:result.clear?result.proportions:'Not clear'};}

import dotenv from 'dotenv';
// Load env vars before any other imports so modules that read process.env at
// module-evaluation time (e.g. claude_service.ts) see the correct values.
dotenv.config();

import express from 'express';
import cors from 'cors';
import { mediaRouter } from './routes/media';
import { signMediaResponses } from './services/media';
import { clothingRouter } from './routes/clothing';
import { imagesRouter } from './routes/images';
import { adminRouter } from './routes/admin';
import { outfitsRouter } from './routes/outfits';
import { weeklyRouter } from './routes/weekly';
import { stylistRouter } from './routes/stylist';
import { wardrobeRouter } from './routes/wardrobe';
import tripsRouter from './routes/trips';
import { userRouter } from './routes/user';
import { requireAuth } from './middleware/auth';
import { requestLogger } from './middleware/request_logger';
import { apiRateLimiter, stylistRateLimiter, createRateLimiter } from './middleware/rate_limit';
import { startCleanupSchedule } from './tasks/cleanup';

const app = express();
const PORT = process.env.PORT ?? 3002;
app.disable('x-powered-by');
// Set explicitly for the hosting topology; raw forwarding headers are never trusted.
const proxyHops=Number(process.env.TRUST_PROXY_HOPS||(process.env.RENDER?'1':'0'));
if(Number.isInteger(proxyHops)&&proxyHops>0&&proxyHops<=3)app.set('trust proxy',proxyHops);

// ── Middleware ────────────────────────────────────────────────────────────────
const origins=[...new Set(['https://clad.style','https://www.clad.style','http://127.0.0.1:5174','http://localhost:5174',...(process.env.ALLOWED_ORIGIN||'').split(',').map(x=>x.trim()).filter(x=>x&&x!=='*')])];
app.use(cors({origin:(origin,done)=>done(null,!origin||origins.includes(origin)),allowedHeaders:['Authorization','Content-Type','Idempotency-Key']}));
app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');next();});
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));

// Temporary photos and generated files must never be served as public static assets.
app.use('/media', createRateLimiter({windowMs:60000,maxRequests:600}), mediaRouter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', createRateLimiter({windowMs:60000,maxRequests:600}));
app.use('/api/admin', adminRouter);
app.use('/api/user', userRouter); // Router handles auth requirements internally
app.use('/api/wardrobe', requireAuth, apiRateLimiter, signMediaResponses, wardrobeRouter);
app.use('/api/clothing', requireAuth, apiRateLimiter, signMediaResponses, clothingRouter);
app.use('/api/images', requireAuth, apiRateLimiter, signMediaResponses, imagesRouter);
app.use('/api/outfits', requireAuth, apiRateLimiter, signMediaResponses, outfitsRouter);
app.use('/api/outfits', requireAuth, apiRateLimiter, signMediaResponses, weeklyRouter);
app.use('/api/stylist', requireAuth, stylistRateLimiter, apiRateLimiter, signMediaResponses, stylistRouter);
app.use('/api/trips', requireAuth, apiRateLimiter, signMediaResponses, tripsRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', release:'beta-security-v1', timestamp: new Date().toISOString() });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[error]', err.stack || err.message);
    
    // Support custom ApiError (and standard status errors)
    const statusCode = err.statusCode || err.status || 500;
    const isClientError = statusCode >= 400 && statusCode < 500;
    
    res.status(statusCode).json({
      error: isClientError ? err.message : 'Internal server error',
      details: err.details || undefined
    });
  },
);

app.listen(PORT, () => {
  console.log(`Wardrobe backend running on http://localhost:${PORT}`);
  startCleanupSchedule();
});

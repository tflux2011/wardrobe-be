import dotenv from 'dotenv';
// Load env vars before any other imports so modules that read process.env at
// module-evaluation time (e.g. claude_service.ts) see the correct values.
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { clothingRouter } from './routes/clothing';
import { imagesRouter } from './routes/images';
import { adminRouter } from './routes/admin';
import { outfitsRouter } from './routes/outfits';
import { stylistRouter } from './routes/stylist';
import { wardrobeRouter } from './routes/wardrobe';
import { requireAuth } from './middleware/auth';
import { requestLogger } from './middleware/request_logger';
import { apiRateLimiter, stylistRateLimiter } from './middleware/rate_limit';
import { startCleanupSchedule } from './tasks/cleanup';

const app = express();
const PORT = process.env.PORT ?? 3002;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));

// Serve uploaded images as static assets from /uploads/*
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', apiRateLimiter);
app.use('/api/admin', adminRouter);
app.use('/api/wardrobe', requireAuth, wardrobeRouter);
app.use('/api/clothing', requireAuth, clothingRouter);
app.use('/api/images', requireAuth, imagesRouter);
app.use('/api/outfits', requireAuth, outfitsRouter);
app.use('/api/stylist', stylistRateLimiter, requireAuth, stylistRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[error]', err.message);
    // Do not expose internal error details to clients
    res.status(500).json({ error: 'Internal server error' });
  },
);

app.listen(PORT, () => {
  console.log(`Wardrobe backend running on http://localhost:${PORT}`);
  startCleanupSchedule();
});

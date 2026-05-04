import dotenv from 'dotenv';
// Load env vars before any other imports so modules that read process.env at
// module-evaluation time (e.g. claude_service.ts) see the correct values.
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { clothingRouter } from './routes/clothing';
import { imagesRouter } from './routes/images';
import { outfitsRouter } from './routes/outfits';
import { stylistRouter } from './routes/stylist';

const app = express();
const PORT = process.env.PORT ?? 3002;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
app.use(express.json({ limit: '10mb' }));

// Serve uploaded images as static assets from /uploads/*
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/clothing', clothingRouter);
app.use('/api/images', imagesRouter);
app.use('/api/outfits', outfitsRouter);
app.use('/api/stylist', stylistRouter);

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
});

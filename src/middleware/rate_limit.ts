import { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  maxRequests: number;
};

type ClientEntry = {
  count: number;
  resetAtMs: number;
};

function getClientKey(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function parseEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, maxRequests } = options;
  const clients = new Map<string, ClientEntry>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = getClientKey(req);

    const existing = clients.get(key);
    if (!existing || now >= existing.resetAtMs) {
      clients.set(key, { count: 1, resetAtMs: now + windowMs });
      return next();
    }

    existing.count += 1;

    if (existing.count > maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAtMs - now) / 1000),
      );

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }

    next();
  };
}

export const apiRateLimiter = createRateLimiter({
  windowMs: parseEnvNumber('RATE_LIMIT_WINDOW_MS', 60_000),
  maxRequests: parseEnvNumber('RATE_LIMIT_MAX_REQUESTS', 120),
});

export const stylistRateLimiter = createRateLimiter({
  windowMs: parseEnvNumber('STYLIST_RATE_LIMIT_WINDOW_MS', 60_000),
  maxRequests: parseEnvNumber('STYLIST_RATE_LIMIT_MAX_REQUESTS', 25),
});

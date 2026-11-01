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
  // Express resolves proxies only when explicitly configured; never trust raw headers.
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
    const key = req.user?.uid ? `user:${req.user.uid}` : getClientKey(req);
    for (const [client, entry] of clients) {
      if (now >= entry.resetAtMs) clients.delete(client);
    }

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

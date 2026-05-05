import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

function sanitizedPath(url: string): string {
  const [pathOnly] = url.split('?');
  return pathOnly || '/';
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = Date.now();

  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const path = sanitizedPath(req.originalUrl || req.url);
    const userAgent = req.get('user-agent') ?? 'unknown';

    console.info(
      `[http] id=${requestId} ip=${req.ip} ${req.method} ${path} status=${res.statusCode} durationMs=${durationMs} ua="${userAgent}"`,
    );
  });

  next();
}

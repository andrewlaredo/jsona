// Abuse protection: per-IP fixed-window rate limiting + payload guards.

import type { Request, Response, NextFunction } from 'express';
import { rateLimits } from './db.js';

/**
 * Resolve the client IP.
 *
 * `X-Forwarded-For` is only trusted when TRUST_PROXY is enabled, because a
 * client can forge that header and trivially bypass per-IP limits when the
 * service is exposed directly.
 */
export function clientIp(req: Request): string {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

export interface LimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window. */
  max: number;
  /** Bucket name, so different routes get independent budgets. */
  bucket: string;
}

/**
 * Express middleware enforcing a fixed-window limit, keyed by bucket + IP.
 * Counters live in SQLite so they survive restarts.
 */
export function rateLimit(opts: LimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.bucket}:${clientIp(req)}`;
    let result;
    try {
      result = rateLimits.hit(key, opts.windowMs, opts.max);
    } catch {
      // Never let a limiter failure take the API down.
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'too many requests, please slow down',
        retryAfter,
      });
    }
    next();
  };
}

/** Reject oversized bodies early, before they are parsed or stored. */
export function maxBytes(limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) {
      return res.status(413).json({ error: 'payload too large', limit });
    }
    next();
  };
}

'use strict';

const crypto = require('node:crypto');
const { appError, toPublicError } = require('../constants/errors');

/** Attach an id to every request (reuses a sane incoming one) for log correlation. */
function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  };
}

function securityHeaders({ production = false } = {}) {
  return (req, res, next) => {
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-site',
    });
    next();
  };
}

/** One structured log line per request (no bodies, no tokens). */
function accessLog(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0]; // never log the query string
      if (path === '/api/live') return; // platform health probes would only add noise
      logger.info('request', {
        requestId: req.id,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      });
    });
    next();
  };
}

/** Allow-list CORS: only the configured frontend origins may call the API from a browser. */
function cors(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

/**
 * Fixed-window rate limiter keyed by client address.
 * @param {{windowMs: number, max: number, name?: string, now?: () => number}} opts
 */
function rateLimit({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, windowMs);
  timer.unref();
  return (req, res, next) => {
    const t = now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - t) / 1000)));
      return next(appError('RATE_LIMITED'));
    }
    return next();
  };
}

/** Bearer-token authentication. Sets req.user. */
function requireUser(users) {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization') || '';
      const match = /^Bearer (.+)$/.exec(header);
      const user = match ? await users.authenticate(match[1]) : null;
      if (!user) throw appError('UNAUTHENTICATED');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function notFound() {
  return (req, res, next) => next(appError('NOT_FOUND', { path: req.path }));
}

/** Single place where every REST error becomes a response. */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let error = err;
    if (err && err.type === 'entity.parse.failed') error = appError('VALIDATION_FAILED', { reason: 'invalid JSON' });
    if (err && err.type === 'entity.too.large') error = appError('PAYLOAD_TOO_LARGE');
    const { status, body, expected } = toPublicError(error);
    const log = logger.child({ requestId: req.id });
    if (expected) log.debug('request rejected', { code: body.code, path: req.path });
    else log.error('unhandled request error', { err: error, path: req.path });
    res.status(status).json({ ok: false, error: body });
  };
}

module.exports = { requestId, securityHeaders, accessLog, cors, rateLimit, requireUser, notFound, errorHandler };

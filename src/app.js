'use strict';

const express = require('express');
const {
  requestId, securityHeaders, accessLog, cors, rateLimit, requireUser, notFound, errorHandler,
} = require('./middleware/http');
const { validate } = require('./validators/schema');
const schemas = require('./validators/payloads');
const { appError } = require('./constants/errors');
const sessionsRepo = require('./db/repositories/sessions.repository');

/** Wrap an async handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * REST API. Controllers are intentionally thin: validate, call a service,
 * shape the response. All game logic lives in the engine and platform services.
 */
function createApp(container) {
  const { env, logger, users, rooms, registry, db } = container;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us

  app.use(requestId());
  app.use(securityHeaders({ production: env.isProduction }));
  app.use(accessLog(logger));
  app.use(cors(env.clientOrigins));
  app.use(express.json({ limit: '10kb' }));

  const general = rateLimit({ windowMs: 60000, max: env.rateLimitApi });
  const strict = rateLimit({ windowMs: 60000, max: env.rateLimitStrict });
  const auth = requireUser(users);

  // Liveness probe for the hosting platform: no database, no rate limit.
  app.get('/api/live', (req, res) => res.json({ ok: true, data: { status: 'live' } }));

  const api = express.Router();
  api.use(general);

  api.get('/health', wrap(async (req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true, data: { status: 'up' } });
  }));

  api.get('/games', (req, res) => {
    res.json({ ok: true, data: { games: registry.list() } });
  });

  api.post('/guests', strict, wrap(async (req, res) => {
    const { nickname } = validate(schemas.createGuest, req.body);
    const guest = await users.createGuest(nickname);
    res.status(201).json({ ok: true, data: guest });
  }));

  api.get('/me', auth, (req, res) => {
    res.json({
      ok: true,
      data: { userId: req.user.id, nickname: req.user.nickname, activeRoomCode: rooms.activeRoomCode(req.user.id) },
    });
  });

  api.get('/rooms/:code', strict, (req, res) => {
    const { code } = validate(schemas.roomCodeParam, req.params);
    res.json({ ok: true, data: rooms.preview(code) });
  });

  api.get('/sessions/:id/history', auth, wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw appError('VALIDATION_FAILED', { field: 'id' });
    if (!(await sessionsRepo.isParticipant(db, { sessionId: id, userId: req.user.id }))) throw appError('FORBIDDEN');
    res.json({ ok: true, data: { rounds: await sessionsRepo.loadScoreHistory(db, id) } });
  }));

  app.use('/api', api);
  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };

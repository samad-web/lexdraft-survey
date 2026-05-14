import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './env.js';
import { db } from './db.js';
import { errorHandler } from './middleware/error.js';
import { surveyLimiter, surveyDraftLimiter } from './middleware/rateLimit.js';
import { surveyRouter } from './routes/survey.routes.js';
import { surveyDraftRouter } from './routes/survey-draft.routes.js';

// =============================================================================
// LexDraft Survey - standalone backend.
//
// Public, unauthenticated API. Three endpoints behind IP rate limits:
//   POST /api/survey                    submit final response
//   POST /api/survey/drafts             create an anonymous in-progress draft
//   PUT  /api/survey/drafts/:id         update / mark draft completed
//
// Plus /api/health (liveness) and /api/ready (DB ping).
// =============================================================================

const app = express();
// Trust exactly one proxy hop (Vercel's edge / nginx in front of the
// container). 'true' would let any client spoof X-Forwarded-For and bypass
// per-IP rate limits — express-rate-limit refuses to run in that mode.
app.set('trust proxy', 1);

// Security headers, CORS, JSON body parsing. Body limit kept tight - the
// largest payload is the full survey submission (~10 KB), so 64 KB is
// generous without inviting abuse.
app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigin === '' ? true : env.corsOrigin.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  }),
);
app.use(express.json({ limit: '64kb' }));

// Liveness probe - process is up.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Readiness probe - process is up AND can talk to Postgres.
app.get('/api/ready', async (_req, res) => {
  const sql = db();
  if (!sql) {
    res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
    return;
  }
  const t0 = Date.now();
  try {
    await sql`select 1 as ok`;
    res.json({ ok: true, ms: Date.now() - t0 });
  } catch (err) {
    res.status(503).json({
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// /api/survey/drafts MUST mount before /api/survey so the more specific
// sub-path wins; the survey-draft limiter is more permissive (one respondent
// fires 30-60 PUTs across a session).
app.use('/api/survey/drafts', surveyDraftLimiter, surveyDraftRouter);
app.use('/api/survey',        surveyLimiter,      surveyRouter);

app.use(errorHandler);

export { app };

// Vercel invokes the exported app directly; only listen() when running as
// a standalone Node process.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });
}

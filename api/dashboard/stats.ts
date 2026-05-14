import express from 'express';
import { surveyStatsRouter } from '../../server/src/routes/survey-stats.routes.js';

// =============================================================================
// /api/dashboard/stats - dedicated Vercel function.
//
// The catchall at `api/[...path].ts` should normally route this too, but
// when import tracing or build caching goes sideways on Vercel the
// catchall bundle can ship without the dashboard route registered. An
// explicit per-route file removes that uncertainty: Vercel sees this file
// at `api/dashboard/stats.ts` and routes `/api/dashboard/stats` to it by
// filename alone, no tracing required. The handler is a tiny Express app
// that mounts just the surveyStatsRouter so the existing route code is
// reused as-is.
// =============================================================================

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use('/api/dashboard', surveyStatsRouter);

export default app;

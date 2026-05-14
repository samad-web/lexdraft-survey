import express from 'express';
import { surveyStatsRouter } from '../../server/src/routes/survey-stats.routes.js';

// =============================================================================
// /api/dashboard/data - dedicated Vercel function (DELETE endpoint).
//
// Same reason as `stats.ts`: file-named-after-the-route eliminates the
// catchall / import-tracing failure modes. The surveyStatsRouter
// already declares the DELETE handler on the `/data` sub-path, so this
// file just mounts the router and forwards.
// =============================================================================

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use('/api/dashboard', surveyStatsRouter);

export default app;

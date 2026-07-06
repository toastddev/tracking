import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trackRoutes } from './routes/track';
import { pixelRoutes } from './routes/pixel';
import { postbackRoutes } from './routes/postback';
import { healthRoutes } from './routes/health';
import { adminRoutes } from './routes/admin';
import { integrationsRoutes } from './routes/integrations';
import { facebookIntegrationsRoutes } from './routes/facebookIntegrations';
import { initFirestore } from './firestore';
import { logger } from './utils/logger';
import { affiliateApiScheduler } from './services/affiliateApiScheduler';
import { offerReportsReconciliationScheduler } from './services/offerReportsReconciliationScheduler';
import { encKeyStatus } from './utils/crypto';

// Catch errors that escape Hono's request scope (scheduler ticks, async
// fire-and-forget, Firestore client internals). Without this they vanish
// into Node's default handler and we lose the alert signal.
process.on('uncaughtException', (err) => {
  logger.critical('uncaught_exception', { error: err });
  // Let the process die — Cloud Run will replace the instance. Continuing
  // after an uncaught exception leaves Node in an undefined state.
  setTimeout(() => process.exit(1), 100).unref();
});

process.on('unhandledRejection', (reason) => {
  logger.critical('unhandled_rejection', { error: reason });
});

try {
  initFirestore();
  logger.info('firestore_ready');
  // Fail loud, not silent: affiliate-API auth secrets (bearer tokens / api keys)
  // are stored AES-256-GCM encrypted and decrypted per run. If the key is
  // missing or malformed, every scheduled run would throw deep in decryptSecret
  // and quietly stop pulling conversions. Surface it once, at boot, as CRITICAL.
  const keyStatus = encKeyStatus();
  if (!keyStatus.ok) {
    logger.critical('enc_key_misconfigured', { reason: keyStatus.reason });
  }
  affiliateApiScheduler.start();
  // Single reconciler covers offer_reports + campaign_reports + facebook_campaign_reports
  // in one shared scan per tick — see services/reconciler/unifiedReconciler.ts.
  offerReportsReconciliationScheduler.start();
} catch (err) {
  // Firestore unreachable means clicks/postbacks can't persist and schedulers
  // never start — the app is half-dead and a human must look at it.
  logger.critical('firestore_init_failed', { error: err });
}

const allowedOrigins = (process.env.ADMIN_CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = new Hono();

// CORS only on the admin API. The /click and /postback routes are called
// directly from browsers / network servers and don't need it.
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return '';
      if (allowedOrigins.includes('*')) return origin;
      return allowedOrigins.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 86400,
  })
);

app.route('/', healthRoutes);
app.route('/', trackRoutes);
app.route('/', pixelRoutes);
app.route('/', postbackRoutes);
app.route('/', adminRoutes);
app.route('/', integrationsRoutes);
app.route('/', facebookIntegrationsRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  logger.error('unhandled_error', {
    error: err,
    method: c.req.method,
    path: c.req.path,
    status: 500,
  });
  return c.json({ error: 'internal' }, 500);
});

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info('server_started', { port: info.port });
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logger.info('shutdown_signal', { signal: sig });
    affiliateApiScheduler.stop();
    offerReportsReconciliationScheduler.stop();
    server.close(() => process.exit(0));
  });
}

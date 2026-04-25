import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trackRoutes } from './routes/track';
import { postbackRoutes } from './routes/postback';
import { healthRoutes } from './routes/health';
import { adminRoutes } from './routes/admin';
import { initFirestore } from './firestore';
import { logger } from './utils/logger';

try {
  initFirestore();
  logger.info('firestore_ready');
} catch (err) {
  logger.warn('firestore_init_skipped', {
    error: err instanceof Error ? err.message : String(err),
  });
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
app.route('/', postbackRoutes);
app.route('/', adminRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  logger.error('unhandled_error', {
    error: err.message,
    stack: err.stack,
    path: c.req.path,
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
    server.close(() => process.exit(0));
  });
}

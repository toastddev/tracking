import { Hono } from 'hono';
import { googleAdsController } from '../controllers/googleAdsController';
import { requireAuth } from '../middleware/auth';

export const integrationsRoutes = new Hono();

integrationsRoutes.use('/api/integrations/*', requireAuth);

const base = '/api/integrations/google-ads';

// OAuth handshake → grant token → finalize (creates connections)
integrationsRoutes.post(`${base}/oauth/start`,    (c) => googleAdsController.oauthStart(c));
integrationsRoutes.post(`${base}/oauth/exchange`, (c) => googleAdsController.oauthExchange(c));
integrationsRoutes.post(`${base}/finalize`,       (c) => googleAdsController.finalize(c));

// Connections
integrationsRoutes.get(`${base}/connections`,        (c) => googleAdsController.listConnections(c));
integrationsRoutes.get(`${base}/connections/:id`,    (c) => googleAdsController.getConnection(c));
integrationsRoutes.patch(`${base}/connections/:id`,  (c) => googleAdsController.patchConnection(c));
integrationsRoutes.delete(`${base}/connections/:id`, (c) => googleAdsController.deleteConnection(c));
integrationsRoutes.get(
  `${base}/connections/:id/conversion-actions`,
  (c) => googleAdsController.listConversionActions(c)
);
integrationsRoutes.post(
  `${base}/connections/:id/mcc-children/refresh`,
  (c) => googleAdsController.refreshMccChildren(c)
);

// Routes (which offer/network goes to which CHILD connection)
integrationsRoutes.get(`${base}/routes`,              (c) => googleAdsController.getRoute(c));
integrationsRoutes.get(`${base}/routes/all`,          (c) => googleAdsController.listRoutes(c));
integrationsRoutes.post(`${base}/routes`,             (c) => googleAdsController.upsertRoute(c));
integrationsRoutes.delete(`${base}/routes/:route_id`, (c) => googleAdsController.deleteRoute(c));

// Upload audit / manual retry
integrationsRoutes.get(`${base}/uploads`,                       (c) => googleAdsController.listUploadsForSource(c));
integrationsRoutes.post(`${base}/uploads/:conversion_id/retry`, (c) => googleAdsController.retryUpload(c));

import { Hono } from 'hono';
import { ga4Controller } from '../controllers/ga4Controller';
import { requireAuth } from '../middleware/auth';

// Google Analytics 4 connection (Connections tab). Separate router so the
// Google Ads / Facebook routers stay untouched.
export const ga4IntegrationsRoutes = new Hono();

const base = '/api/integrations/ga4';

ga4IntegrationsRoutes.use(`${base}/*`, requireAuth);

ga4IntegrationsRoutes.post(`${base}/oauth/start`, (c) => ga4Controller.oauthStart(c));
ga4IntegrationsRoutes.post(`${base}/oauth/exchange`, (c) => ga4Controller.oauthExchange(c));

ga4IntegrationsRoutes.get(`${base}/connections`, (c) => ga4Controller.listConnections(c));
ga4IntegrationsRoutes.delete(`${base}/connections/:id`, (c) => ga4Controller.deleteConnection(c));
ga4IntegrationsRoutes.get(`${base}/connections/:id/streams`, (c) => ga4Controller.listStreams(c));
ga4IntegrationsRoutes.post(`${base}/connections/:id/streams`, (c) => ga4Controller.linkStream(c));

ga4IntegrationsRoutes.patch(`${base}/streams/:measurement_id`, (c) => ga4Controller.patchStream(c));
ga4IntegrationsRoutes.delete(`${base}/streams/:measurement_id`, (c) => ga4Controller.unlinkStream(c));
ga4IntegrationsRoutes.post(`${base}/streams/:measurement_id/test`, (c) => ga4Controller.testStream(c));

ga4IntegrationsRoutes.get(`${base}/settings`, (c) => ga4Controller.getSettings(c));
ga4IntegrationsRoutes.patch(`${base}/settings`, (c) => ga4Controller.patchSettings(c));

// Upload audit / manual retry (same as the Google Ads uploads endpoints)
ga4IntegrationsRoutes.get(`${base}/uploads`, (c) => ga4Controller.listUploadsForSource(c));
ga4IntegrationsRoutes.get(`${base}/uploads/list`, (c) => ga4Controller.listUploads(c));
ga4IntegrationsRoutes.get(`${base}/uploads/export`, (c) => ga4Controller.exportUploads(c));
ga4IntegrationsRoutes.post(`${base}/uploads/:conversion_id/retry`, (c) => ga4Controller.retryUpload(c));

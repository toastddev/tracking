import { Hono } from 'hono';
import { facebookController } from '../controllers/facebookController';
import { fbCampaignReportsController } from '../controllers/fbCampaignReportsController';
import { requireAuth } from '../middleware/auth';

// Mirror of ./integrations.ts. New sub-router so the existing GAds router
// stays textually untouched (no risk of accidentally regressing GAds routes
// while adding FB ones).

export const facebookIntegrationsRoutes = new Hono();

facebookIntegrationsRoutes.use('/api/integrations/*', requireAuth);
facebookIntegrationsRoutes.use('/api/fb-campaign-reports/*', requireAuth);

const base = '/api/integrations/facebook';

// ── PUBLIC OAuth callback ───────────────────────────────────────────
// This is what Meta redirects the user-agent to after consent. NOT under
// /api/integrations/*, so the requireAuth middleware above does NOT fire.
// That's the whole point: when Meta redirects a user back to our domain,
// any in-app auth cookie may not survive the cross-site hop, and an outer
// SPA auth guard (e.g. pennywise-admin) would bounce the URL to /login and
// kill the ?code & ?state params. The backend exchanges code → token here,
// stashes the result in a 5-min Firestore session, then 302s the browser
// to the frontend Connections page with ?fb_oauth_session=<id>.
facebookIntegrationsRoutes.get('/oauth/facebook/callback', (c) => facebookController.handleCallback(c));

// OAuth handshake
facebookIntegrationsRoutes.post(`${base}/oauth/start`,    (c) => facebookController.oauthStart(c));
facebookIntegrationsRoutes.post(`${base}/oauth/exchange`, (c) => facebookController.oauthExchange(c));
facebookIntegrationsRoutes.post(`${base}/finalize`,       (c) => facebookController.finalize(c));

// PROTECTED — frontend consumes the OAuth session that handleCallback stashed.
// Returns candidates + grant_token, then the modal flow continues unchanged.
facebookIntegrationsRoutes.get(
  `${base}/oauth/consume-session/:session_id`,
  (c) => facebookController.consumeSession(c)
);

// Connections
facebookIntegrationsRoutes.get(`${base}/connections`,        (c) => facebookController.listConnections(c));
facebookIntegrationsRoutes.get(`${base}/connections/:id`,    (c) => facebookController.getConnection(c));
facebookIntegrationsRoutes.patch(`${base}/connections/:id`,  (c) => facebookController.patchConnection(c));
facebookIntegrationsRoutes.delete(`${base}/connections/:id`, (c) => facebookController.deleteConnection(c));
facebookIntegrationsRoutes.get(
  `${base}/connections/:id/datasets`,
  (c) => facebookController.listDatasets(c)
);
facebookIntegrationsRoutes.get(
  `${base}/connections/:id/custom-events`,
  (c) => facebookController.listCustomEvents(c)
);
facebookIntegrationsRoutes.post(
  `${base}/connections/:id/business-children/refresh`,
  (c) => facebookController.refreshBusinessChildren(c)
);

// Routes (offer/network -> ad_account)
facebookIntegrationsRoutes.get(`${base}/routes`,              (c) => facebookController.getRoute(c));
facebookIntegrationsRoutes.get(`${base}/routes/all`,          (c) => facebookController.listRoutes(c));
facebookIntegrationsRoutes.post(`${base}/routes`,             (c) => facebookController.upsertRoute(c));
facebookIntegrationsRoutes.delete(`${base}/routes/:route_id`, (c) => facebookController.deleteRoute(c));

// Upload audit / manual retry / CSV export
facebookIntegrationsRoutes.get(`${base}/uploads`,                       (c) => facebookController.listUploadsForSource(c));
facebookIntegrationsRoutes.get(`${base}/uploads/export`,                (c) => facebookController.exportUploads(c));
facebookIntegrationsRoutes.post(`${base}/uploads/:conversion_id/retry`, (c) => facebookController.retryUpload(c));

// Sync — manual trigger from the FB Campaign Reports page, plus sync-state
// (last_synced_at, pref_from, pref_to) endpoints used by the toolbar.
facebookIntegrationsRoutes.post(`${base}/sync`,             (c) => facebookController.syncCampaigns(c));
facebookIntegrationsRoutes.get(`${base}/sync/state`,        (c) => facebookController.getSyncState(c));
facebookIntegrationsRoutes.post(`${base}/sync/prefs`,       (c) => facebookController.saveSyncPrefs(c));

// ── FB Campaign Reports (dashboard read API) ────────────────────────
const reportsBase = '/api/fb-campaign-reports';
facebookIntegrationsRoutes.get(`${reportsBase}/summary`,         (c) => fbCampaignReportsController.summary(c));
facebookIntegrationsRoutes.get(`${reportsBase}/by-campaign/:id`, (c) => fbCampaignReportsController.byCampaign(c));
facebookIntegrationsRoutes.post(`${reportsBase}/spend`,          (c) => fbCampaignReportsController.setSpend(c));
facebookIntegrationsRoutes.post(`${reportsBase}/sync`,           (c) => fbCampaignReportsController.sync(c));

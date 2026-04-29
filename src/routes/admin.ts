import { Hono } from 'hono';
import { adminController } from '../controllers/adminController';
import { affiliateApiController } from '../controllers/affiliateApiController';
import { requireAuth } from '../middleware/auth';

export const adminRoutes = new Hono();

// Public — login
adminRoutes.post('/api/auth/login', (c) => adminController.login(c));

// Everything below is gated on a valid Bearer token.
adminRoutes.use('/api/*', requireAuth);

adminRoutes.get('/api/me', (c) => adminController.me(c));

// Offers
adminRoutes.get('/api/offers', (c) => adminController.listOffers(c));
adminRoutes.post('/api/offers', (c) => adminController.createOffer(c));
adminRoutes.get('/api/offers/:id', (c) => adminController.getOffer(c));
adminRoutes.patch('/api/offers/:id', (c) => adminController.updateOffer(c));
adminRoutes.delete('/api/offers/:id', (c) => adminController.deleteOffer(c));

// Networks (postback configurations)
adminRoutes.get('/api/networks', (c) => adminController.listNetworks(c));
adminRoutes.post('/api/networks', (c) => adminController.createNetwork(c));
adminRoutes.get('/api/networks/:id', (c) => adminController.getNetwork(c));
adminRoutes.patch('/api/networks/:id', (c) => adminController.updateNetwork(c));
adminRoutes.delete('/api/networks/:id', (c) => adminController.deleteNetwork(c));
adminRoutes.get('/api/networks/:id/conversions', (c) => adminController.listNetworkConversions(c));

// Cross-network conversions list (reports)
adminRoutes.get('/api/conversions', (c) => adminController.listAllConversions(c));

// Conversion detail (with hydrated click for verified conversions)
adminRoutes.get('/api/conversions/:id', (c) => adminController.getConversion(c));

// Clicks list + detail (reports)
adminRoutes.get('/api/clicks', (c) => adminController.listClicks(c));
adminRoutes.get('/api/clicks/:id', (c) => adminController.getClick(c));

// Reports
adminRoutes.get('/api/reports/summary', (c) => adminController.reportSummary(c));
adminRoutes.get('/api/reports/timeseries', (c) => adminController.reportTimeseries(c));

// Affiliate APIs (pull-based conversion ingestion)
adminRoutes.get('/api/affiliate-apis', (c) => affiliateApiController.list(c));
adminRoutes.post('/api/affiliate-apis', (c) => affiliateApiController.create(c));
adminRoutes.get('/api/affiliate-apis/:id', (c) => affiliateApiController.get(c));
adminRoutes.patch('/api/affiliate-apis/:id', (c) => affiliateApiController.update(c));
adminRoutes.delete('/api/affiliate-apis/:id', (c) => affiliateApiController.delete(c));
adminRoutes.post('/api/affiliate-apis/:id/run', (c) => affiliateApiController.runNow(c));
adminRoutes.post('/api/affiliate-apis/:id/unlock', (c) => affiliateApiController.forceUnlock(c));
adminRoutes.post('/api/affiliate-apis/:id/test', (c) => affiliateApiController.testRun(c));
adminRoutes.get('/api/affiliate-apis/:id/runs', (c) => affiliateApiController.runs(c));

// Settings → destructive ops
adminRoutes.post('/api/settings/reset-data', (c) => adminController.resetData(c));

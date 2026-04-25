import { Hono } from 'hono';
import { adminController } from '../controllers/adminController';
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

// Clicks list (reports)
adminRoutes.get('/api/clicks', (c) => adminController.listClicks(c));

// Reports
adminRoutes.get('/api/reports/summary', (c) => adminController.reportSummary(c));
adminRoutes.get('/api/reports/timeseries', (c) => adminController.reportTimeseries(c));

import { Hono } from 'hono';
import { trackController } from '../controllers/trackController';

export const trackRoutes = new Hono();

trackRoutes.get('/click/:offer_id', (c) => trackController.redirect(c));

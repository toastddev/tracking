import { Hono } from 'hono';
import { postbackController } from '../controllers/postbackController';

export const postbackRoutes = new Hono();

// Network id is part of the path so each network has a stable, unique URL
// to register with — and so the service knows which mapping doc to load.
postbackRoutes.get('/postback/:network_id', (c) => postbackController.handle(c));
postbackRoutes.post('/postback/:network_id', (c) => postbackController.handle(c));

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { pixelController } from '../controllers/pixelController';

export const pixelRoutes = new Hono();

// CORS for the pixel endpoint. The frontend issues this as a simple GET with
// no custom headers, so for `mode: 'no-cors'` the browser sends the request
// without needing CORS at all. We still allow `*` here so a future caller
// using `mode: 'cors'` (to inspect the 204 response) keeps working — the
// endpoint returns no body and stores only what the URL already carries, so
// there's nothing sensitive to gate behind a stricter origin allowlist.
pixelRoutes.use('/pixel/*', cors({
  origin: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  credentials: false,
  maxAge: 86400,
}));

// GET only. POST/sendBeacon would force a content-type header that triggers
// preflight in some configurations; the simple-GET model is the safest path
// for a fire-and-forget pixel that must survive page navigation.
pixelRoutes.get('/pixel/click', (c) => pixelController.handle(c));

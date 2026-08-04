import { Hono } from 'hono';

export const rootRoutes = new Hono();

// Friendly 200 on the bare domain. Before this, `/` fell through to the
// catch-all and returned `{"error":"not_found"}` with a 404 — which looks like
// an outage to anyone (including an uptime check) who probes the root.
//
// Deliberately says nothing about the stack, version, or environment: this is
// a public, unauthenticated origin, and a version string is free reconnaissance.
rootRoutes.get('/', (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.json({ status: 'ok', message: 'Hello. Tracking service is running.' });
});

// This origin serves redirects, pixels, postbacks and an admin API — there is
// no content worth indexing, and search results pointing at tracking endpoints
// are pure noise.
//
// IMPORTANT — why the AdsBot groups are listed separately:
// Google's AdsBot crawlers do NOT obey the `User-agent: *` group. They only
// follow a group that names them explicitly. That means the blanket Disallow
// below never blocks Google Ads landing-page checks by accident — but it also
// means that if someone later adds `User-agent: AdsBot-Google / Disallow: /`,
// any ad whose final URL touches this domain (e.g. a /click/:offer_id redirect)
// gets disapproved as "destination not crawlable". The explicit Allow groups
// are here so that stays true on purpose rather than by luck.
//
// facebookexternalhit is Meta's link/destination fetcher — the one that runs
// when a link is used in an ad or shared. meta-externalagent (AI training) is
// deliberately NOT allowed; it stays under the wildcard Disallow.
const ROBOTS_TXT = `# Tracking infrastructure — nothing here to index.
User-agent: *
Disallow: /

# Google Ads destination checks. AdsBot ignores the wildcard group above, so it
# must be named explicitly. Blocking these would get ads disapproved.
User-agent: AdsBot-Google
Allow: /

User-agent: AdsBot-Google-Mobile
Allow: /

User-agent: AdsBot-Google-Mobile-Apps
Allow: /

# Meta ad destination / link fetches.
User-agent: facebookexternalhit
Allow: /
`;

rootRoutes.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(ROBOTS_TXT);
});

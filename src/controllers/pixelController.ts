import type { Context } from 'hono';
import { extractAdIds, extractExtraParams, extractSubParams } from '../utils/paramExtractor';
import { offerService } from '../services/offerService';
import { clickService } from '../services/clickService';
import { isRefererBlocked } from '../utils/refererBlocklist';
import { logger } from '../utils/logger';

// Loose UUID check — we accept any UUID (not just v7) so the endpoint stays
// flexible, but we reject obvious junk so the docs collection doesn't fill
// with garbage IDs from probers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pixel endpoint reserved keys — everything else (s1..sN, gclid, utm_*, ...)
// flows through the same extractors as the redirect endpoint, so pixel clicks
// land in the dashboard with the same structured data shape.
const PIXEL_RESERVED = new Set(['click_id', 'offer_id', 'aff_id', 'redirect_url']);

function headerGetter(c: Context) {
  return { get: (k: string) => c.req.header(k) ?? undefined };
}

function clientIp(c: Context): string | undefined {
  const h = headerGetter(c);
  return (
    h.get('cf-connecting-ip') ||
    h.get('x-real-ip') ||
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  );
}

// Strip the pixel-specific reserved keys before handing the query off to the
// generic extractors. Without this, `redirect_url` would land in
// `extra_params` and bloat the click doc with a duplicate of the URL.
function trackingQuery(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (PIXEL_RESERVED.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export const pixelController = {
  async handle(c: Context) {
    const query = c.req.query();

    const click_id = (query.click_id ?? '').trim();
    if (!click_id || !UUID_RE.test(click_id)) {
      // 400 is the right code semantically, but the frontend doesn't read the
      // response (no-cors / sendBeacon) — so the user-visible navigation has
      // already happened. The log is what the operator sees.
      logger.warn('pixel_click_invalid_id', { click_id });
      return c.body(null, 400);
    }

    const offer_id = (query.offer_id ?? '').trim();
    const aff_id = (query.aff_id ?? '').trim() || offer_id;
    const redirect_url = (query.redirect_url ?? '').trim();

    // Referer blocklist runs even though the user has already navigated —
    // botnets that scrape the page and replay the pixel still get filtered
    // out of reporting. Persisted as a blocked click for the audit trail.
    const referrer = c.req.header('referer');
    if (isRefererBlocked(referrer)) {
      const blockedClick = clickService.buildBlocked({
        offer_id,
        aff_id,
        sub_params: extractSubParams(trackingQuery(query)),
        ad_ids: extractAdIds(trackingQuery(query)),
        extra_params: extractExtraParams(trackingQuery(query)),
        ip: clientIp(c),
        user_agent: c.req.header('user-agent'),
        referrer,
        country: c.req.header('cf-ipcountry'),
      });
      clickService.persistBlockedAsync(blockedClick);

      logger.info('pixel_click_blocked_referer', {
        click_id,
        offer_id,
        referrer,
      });
      return c.body(null, 204);
    }

    // Tolerant offer lookup — the click is recorded either way. When the
    // lookup fails or offer_id was blank, `buildPixel` flags the click with
    // `offer_unmapped` so it shows up yellow in the dashboard and the
    // operator can fix the frontend DIRECT_AFFILIATES entry.
    const offer = offer_id ? await offerService.fetch(offer_id).catch(() => null) : null;

    const click = clickService.buildPixel({
      click_id,
      offer_id,
      aff_id,
      offer,
      redirect_url,
      sub_params: extractSubParams(trackingQuery(query)),
      ad_ids: extractAdIds(trackingQuery(query)),
      extra_params: extractExtraParams(trackingQuery(query)),
      ip: clientIp(c),
      user_agent: c.req.header('user-agent'),
      referrer,
      country: c.req.header('cf-ipcountry'),
    });

    // Critical: do not await. The frontend fired this fire-and-forget; any
    // wait here just consumes server capacity. Persistence is idempotent on
    // click_id so retried pings collapse into a single click record.
    clickService.persistPixelAsync(click);

    logger.info('pixel_click_recorded', {
      click_id: click.click_id,
      offer_id: click.offer_id,
      aff_id: click.aff_id,
      offer_unmapped: click.offer_unmapped ?? false,
    });

    return c.body(null, 204);
  },
};

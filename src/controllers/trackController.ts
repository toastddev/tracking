import type { Context } from 'hono';
import { extractAdIds, extractExtraParams, extractMetaIds, extractSubParams } from '../utils/paramExtractor';
import { requireParams } from '../utils/validator';
import { offerService } from '../services/offerService';
import { clickService } from '../services/clickService';
import { isRefererBlocked, BLOCKED_REFERER_HTML } from '../utils/refererBlocklist';
import { logger } from '../utils/logger';

// Round-trip Meta's `_fbc` / `_fbp` cookies on the redirect response so the
// synthesised value survives the next visit. Domain defaults to the request
// host; operators serving multi-subdomain trackers set META_COOKIE_DOMAIN to
// the apex (e.g. `.example.com`).
function setMetaCookies(c: Context, cookies: Array<{ name: string; value: string }>) {
  if (cookies.length === 0) return;
  const ttlDays = Math.max(1, Number(process.env.META_COOKIE_TTL_DAYS ?? 90));
  const maxAge = ttlDays * 24 * 60 * 60;
  const domain = process.env.META_COOKIE_DOMAIN || '';
  for (const ck of cookies) {
    const parts = [
      `${ck.name}=${encodeURIComponent(ck.value)}`,
      `Max-Age=${maxAge}`,
      'Path=/',
      'SameSite=Lax',
    ];
    if (domain) parts.push(`Domain=${domain}`);
    c.header('Set-Cookie', parts.join('; '), { append: true });
  }
}

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

export const trackController = {
  async redirect(c: Context) {
    const offer_id = c.req.param('offer_id');
    const query = c.req.query();

    // Honour an explicit ?aff_id= when the caller sends one, otherwise fall
    // back to the offer slug. Mirrors the pixel endpoint so both tracking paths
    // populate aff_id consistently and the affiliate dimension in reports is
    // real rather than always equal to offer_id.
    const aff_id = (query.aff_id ?? '').trim() || offer_id!;

    const check = requireParams({ offer_id, aff_id }, ['offer_id', 'aff_id']);
    if (!check.ok) {
      return c.json({ error: 'missing_params', missing: check.missing }, 400);
    }

    // Pull Meta identifiers (fbc/fbp cookies + URL fbclid) up front so both
    // the blocked-click path and the redirect path persist them. Cookies the
    // client doesn't yet have are queued for Set-Cookie on the response.
    const cookieHeader = c.req.header('cookie');
    const metaIdResult = extractMetaIds(query, cookieHeader);

    // Referer blocklist: in-memory Set lookup, no I/O. Checked before the
    // offer fetch so blocked traffic never touches Firestore for the offer.
    const referrer = c.req.header('referer');
    if (isRefererBlocked(referrer)) {
      // Record the blocked click for later review. Fire-and-forget — the 403
      // returns immediately and never waits on the DB write.
      const blockedClick = clickService.buildBlocked({
        offer_id: offer_id!,
        aff_id,
        sub_params: extractSubParams(query),
        ad_ids: extractAdIds(query),
        extra_params: extractExtraParams(query),
        meta_ids: metaIdResult.meta_ids,
        ip: clientIp(c),
        user_agent: c.req.header('user-agent'),
        referrer,
        country: c.req.header('cf-ipcountry'),
      });
      clickService.persistBlockedAsync(blockedClick);

      logger.info('click_blocked_referer', {
        click_id: blockedClick.click_id,
        offer_id,
        referrer,
      });
      return c.html(BLOCKED_REFERER_HTML, 403);
    }

    const offer = await offerService.fetch(offer_id!);
    if (!offer) return c.json({ error: 'offer_not_found' }, 404);
    if (offer.status !== 'active') return c.json({ error: 'offer_inactive' }, 410);

    const click = clickService.build({
      offer,
      aff_id: aff_id,
      sub_params: extractSubParams(query),
      ad_ids: extractAdIds(query),
      extra_params: extractExtraParams(query),
      meta_ids: metaIdResult.meta_ids,
      ip: clientIp(c),
      user_agent: c.req.header('user-agent'),
      referrer,
      country: c.req.header('cf-ipcountry'),
    });

    // Critical: do not await. The redirect must return immediately; persistence
    // is best-effort and failures are logged inside persistAsync.
    clickService.persistAsync(click);

    setMetaCookies(c, metaIdResult.set_cookies);

    logger.info('click_redirect', {
      click_id: click.click_id,
      offer_id: click.offer_id,
      aff_id: click.aff_id,
    });

    return c.redirect(click.redirect_url, 302);
  },
};

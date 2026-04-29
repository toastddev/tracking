import type { Context } from 'hono';
import { extractAdIds, extractExtraParams, extractSubParams } from '../utils/paramExtractor';
import { requireParams } from '../utils/validator';
import { offerService } from '../services/offerService';
import { clickService } from '../services/clickService';
import { logger } from '../utils/logger';

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

    const check = requireParams({ offer_id, ...query }, ['offer_id', 'aff_id']);
    if (!check.ok) {
      return c.json({ error: 'missing_params', missing: check.missing }, 400);
    }

    const offer = await offerService.fetch(offer_id!);
    if (!offer) return c.json({ error: 'offer_not_found' }, 404);
    if (offer.status !== 'active') return c.json({ error: 'offer_inactive' }, 410);

    const click = clickService.build({
      offer,
      aff_id: query.aff_id!,
      sub_params: extractSubParams(query),
      ad_ids: extractAdIds(query),
      extra_params: extractExtraParams(query),
      ip: clientIp(c),
      user_agent: c.req.header('user-agent'),
      referrer: c.req.header('referer'),
      country: c.req.header('cf-ipcountry'),
    });

    // Critical: do not await. The redirect must return immediately; persistence
    // is best-effort and failures are logged inside persistAsync.
    clickService.persistAsync(click);

    logger.info('click_redirect', {
      click_id: click.click_id,
      offer_id: click.offer_id,
      aff_id: click.aff_id,
    });

    return c.redirect(click.redirect_url, 302);
  },
};

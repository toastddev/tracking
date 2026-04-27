import { generateClickId } from '../utils/idGenerator';
import { renderTemplate } from '../utils/templateEngine';
import { logger } from '../utils/logger';
import { clickRepository } from '../firestore';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import type { AdIds, ClickRecord, Offer } from '../types';

export interface BuildClickInput {
  offer: Offer;
  aff_id: string;
  sub_params: Record<string, string>;
  ad_ids: AdIds;
  ip?: string;
  user_agent?: string;
  referrer?: string;
  country?: string;
}

export const clickService = {
  build(input: BuildClickInput): ClickRecord {
    const click_id = generateClickId();
    const { offer, aff_id, sub_params, ad_ids } = input;

    const context: Record<string, string | undefined> = {
      click_id,
      offer_id: offer.offer_id,
      aff_id,
      ...offer.default_params,
      ...sub_params,
      ...ad_ids,
    };

    const redirect_url = renderTemplate(offer.base_url, context);

    return {
      click_id,
      offer_id: offer.offer_id,
      aff_id,
      sub_params,
      ad_ids,
      ip: input.ip,
      user_agent: input.user_agent,
      referrer: input.referrer,
      country: input.country,
      redirect_url,
      created_at: new Date().toISOString(),
    };
  },

  // Fire-and-forget. Requirement: redirect must be fast and never block on the
  // DB write. Persist failures are logged and swallowed — the user has already
  // been redirected by the time this rejects.
  persistAsync(click: ClickRecord): void {
    clickRepository.insert(click).catch((err: unknown) => {
      logger.error('click_persist_failed', {
        click_id: click.click_id,
        offer_id: click.offer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Fan out to Google Ads only when the click came from Google (gclid/gbraid/wbraid).
    // Non-Google clicks short-circuit inside the service with no DB write.
    if (click.ad_ids?.gclid || click.ad_ids?.gbraid || click.ad_ids?.wbraid) {
      googleAdsForwardingService.forgetClick({ click });
    }
  },
};

import { generateClickId } from '../utils/idGenerator';
import { renderTemplate } from '../utils/templateEngine';
import { logger } from '../utils/logger';
import { clickRepository, offerReportRepository } from '../firestore';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import type { AdIds, ClickRecord, Offer } from '../types';

export interface BuildClickInput {
  offer: Offer;
  aff_id: string;
  sub_params: Record<string, string>;
  ad_ids: AdIds;
  extra_params: Record<string, string>;
  ip?: string;
  user_agent?: string;
  referrer?: string;
  country?: string;
}

export const clickService = {
  build(input: BuildClickInput): ClickRecord {
    const click_id = generateClickId();
    const { offer, aff_id, sub_params, ad_ids, extra_params } = input;

    // Order matters: extras come first so a structured key (sub_params,
    // ad_ids) wins on collision. Defaults fill blanks last via the spread
    // order. Extras then become available to the URL template — useful for
    // forwarding utm_* into the offer link.
    const context: Record<string, string | undefined> = {
      click_id,
      offer_id: offer.offer_id,
      aff_id,
      ...offer.default_params,
      ...extra_params,
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
      extra_params,
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

    // Roll-up into the TTL-safe offer_reports collection so historical
    // reporting survives the 90-day click TTL. Independent of the raw insert
    // — failure here is logged but never blocks the redirect path.
    offerReportRepository
      .incrementClick({ offer_id: click.offer_id, at: new Date(click.created_at) })
      .catch((err: unknown) => {
        logger.warn('offer_report_click_increment_failed', {
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

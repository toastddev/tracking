import { generateClickId } from '../utils/idGenerator';
import { renderTemplate } from '../utils/templateEngine';
import { logger } from '../utils/logger';
import {
  clickRepository,
  offerReportRepository,
  drilldownRepository,
  campaignReportRepository,
} from '../firestore';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import type { AdIds, ClickRecord, Offer } from '../types';

// Pull a campaign id off the click's extra_params. `gad_campaignid` is the
// canonical Google Ads tag; `utm_campaign` is the cross-platform fallback so
// Facebook / TikTok / native / organic UTM-tagged clicks also feed the rollup.
function extractCampaign(
  extra_params: Record<string, string> | undefined
): { campaign_id: string; source: 'gad_campaignid' | 'utm_campaign' } | null {
  if (!extra_params) return null;
  const gad = extra_params.gad_campaignid;
  if (typeof gad === 'string' && gad.trim()) {
    return { campaign_id: gad.trim(), source: 'gad_campaignid' };
  }
  const utm = extra_params.utm_campaign;
  if (typeof utm === 'string' && utm.trim()) {
    return { campaign_id: utm.trim(), source: 'utm_campaign' };
  }
  return null;
}

export const __campaignFromExtra = extractCampaign;

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

    drilldownRepository.incrementOfferClick(click).catch((err: unknown) => {
      logger.warn('drilldown_offer_click_increment_failed', {
        click_id: click.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Campaign rollup. Fed only when the click carries a Google Ads campaign
    // id or a utm_campaign tag — non-tagged organic traffic doesn't produce
    // a campaign row. Same fire-and-forget contract as the offer rollup.
    const campaign = extractCampaign(click.extra_params);
    if (campaign) {
      campaignReportRepository.incrementClick({
        campaign_id: campaign.campaign_id,
        source: campaign.source,
        at: new Date(click.created_at),
        offer_id: click.offer_id,
      }).catch((err: unknown) => {
        logger.warn('campaign_report_click_increment_failed', {
          click_id: click.click_id,
          campaign_id: campaign.campaign_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Fan out to Google Ads only when the click came from Google (gclid/gbraid/wbraid).
    // Non-Google clicks short-circuit inside the service with no DB write.
    if (click.ad_ids?.gclid || click.ad_ids?.gbraid || click.ad_ids?.wbraid) {
      googleAdsForwardingService.forgetClick({ click });
    }
  },
};

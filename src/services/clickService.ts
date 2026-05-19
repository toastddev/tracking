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
import { retry } from '../utils/retry';
import type { AdIds, ClickRecord, Offer } from '../types';

// Pull a campaign id off the click. `gad_campaignid` (extra_params) is the
// canonical Google Ads tag; `utm_campaign` is the cross-platform fallback.
// Final fallback: a click that carries a gclid/gbraid/wbraid (real Google Ads
// click) but neither campaign tag is attributed to a synthetic
// `gads_untagged` campaign — the conversion is real GAds revenue and would
// otherwise vanish from campaign_reports entirely (offer_reports still has it
// raw in USD). Source is reported as `gad_campaignid` so it groups under
// Google Ads in the dashboard.
export const GADS_UNTAGGED_CAMPAIGN_ID = 'gads_untagged';
export const GADS_UNTAGGED_CAMPAIGN_NAME = 'GAds (untagged)';

function extractCampaign(
  click: { extra_params?: Record<string, string>; ad_ids?: AdIds } | undefined
): {
  campaign_id: string;
  source: 'gad_campaignid' | 'utm_campaign';
  campaign_name?: string;
} | null {
  if (!click) return null;
  const gad = click.extra_params?.gad_campaignid;
  if (typeof gad === 'string' && gad.trim()) {
    return { campaign_id: gad.trim(), source: 'gad_campaignid' };
  }
  const utm = click.extra_params?.utm_campaign;
  if (typeof utm === 'string' && utm.trim()) {
    return { campaign_id: utm.trim(), source: 'utm_campaign' };
  }
  const ad = click.ad_ids;
  if (ad && (ad.gclid || ad.gbraid || ad.wbraid)) {
    return {
      campaign_id: GADS_UNTAGGED_CAMPAIGN_ID,
      source: 'gad_campaignid',
      campaign_name: GADS_UNTAGGED_CAMPAIGN_NAME,
    };
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

// A click rejected by the referer blocklist. No `offer` is needed — the block
// fires before the offer fetch — so this carries only what the request itself
// provided.
export interface BuildBlockedClickInput {
  offer_id: string;
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

  // Builds a ClickRecord for a request stopped by the referer blocklist.
  // redirect_url is empty (the user was never redirected) and `blocked` is set
  // so reporting can distinguish it from a real click.
  buildBlocked(input: BuildBlockedClickInput): ClickRecord {
    return {
      click_id: generateClickId(),
      offer_id: input.offer_id,
      aff_id: input.aff_id,
      sub_params: input.sub_params,
      ad_ids: input.ad_ids,
      extra_params: input.extra_params,
      ip: input.ip,
      user_agent: input.user_agent,
      referrer: input.referrer,
      country: input.country,
      redirect_url: '',
      blocked: true,
      created_at: new Date().toISOString(),
    };
  },

  // Fire-and-forget persist for a blocked click. Unlike persistAsync this
  // writes ONLY the clicks document — blocked traffic must never feed the
  // offer/campaign/drilldown rollups, or report totals would be inflated by
  // requests that were never redirected.
  persistBlockedAsync(click: ClickRecord): void {
    retry(() => clickRepository.insert(click)).catch((err: unknown) => {
      logger.error('blocked_click_persist_failed', {
        click_id: click.click_id,
        offer_id: click.offer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  // Fire-and-forget. Requirement: redirect must be fast and never block on the
  // DB write. Each side-effect runs through `retry()` so a transient Firestore
  // error gets up to 3 attempts (~700ms total) BEFORE it gets logged and
  // swallowed. The retry runs detached from the redirect — no added latency on
  // the user-visible path. The reconciliation scheduler is the long-tail
  // safety net if all retries fail.
  persistAsync(click: ClickRecord): void {
    retry(() => clickRepository.insert(click)).catch((err: unknown) => {
      logger.error('click_persist_failed', {
        click_id: click.click_id,
        offer_id: click.offer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Roll-up into the TTL-safe offer_reports collection so historical
    // reporting survives the 90-day click TTL.
    retry(() =>
      offerReportRepository.incrementClick({
        offer_id: click.offer_id,
        at: new Date(click.created_at),
      })
    ).catch((err: unknown) => {
      logger.warn('offer_report_click_increment_failed', {
        click_id: click.click_id,
        offer_id: click.offer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    retry(() => drilldownRepository.incrementOfferClick(click)).catch((err: unknown) => {
      logger.warn('drilldown_offer_click_increment_failed', {
        click_id: click.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Campaign rollup. Fed when the click carries a Google Ads campaign id,
    // a utm_campaign tag, or any Google Ads click identifier (gclid/gbraid/
    // wbraid) — the last falls through to the synthetic `gads_untagged`
    // campaign so real GAds revenue without a campaign tag still shows up.
    const campaign = extractCampaign(click);
    if (campaign) {
      retry(() =>
        campaignReportRepository.incrementClick({
          campaign_id: campaign.campaign_id,
          campaign_name: campaign.campaign_name,
          source: campaign.source,
          at: new Date(click.created_at),
          offer_id: click.offer_id,
        })
      ).catch((err: unknown) => {
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

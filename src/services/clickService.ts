import { generateClickId } from '../utils/idGenerator';
import { renderTemplate } from '../utils/templateEngine';
import { logger } from '../utils/logger';
import {
  clickRepository,
  offerReportRepository,
  drilldownRepository,
  campaignReportRepository,
  facebookCampaignReportRepository,
  NO_MATCH_CAMPAIGN_ID,
  NO_MATCH_CAMPAIGN_NAME,
} from '../firestore';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import { facebookForwardingService } from './facebookForwardingService';
import { extractFbCampaign, hasAnyUtmParam } from './facebookCampaignExtractor';
import { retry } from '../utils/retry';
import type { AdIds, ClickRecord, Offer } from '../types';

// Pull a Google Ads campaign id off the click. Strict — only identifiers Google
// itself emits qualify, never generic utm_*. Priority:
//   1. extra_params.gad_campaignid  — operator/template-set canonical id
//   2. ad_ids.gclid / gbraid / wbraid — real GAds click without a campaign tag,
//      bucketed into the synthetic `gads_untagged` campaign so the revenue is
//      not lost from campaign_reports (offer_reports still has it raw).
//
// utm_campaign is intentionally NOT a fallback. It was leaking Facebook (and
// other) traffic into Google rollups because every UTM-tagged click was being
// claimed as "Google". A click without a Google identifier is not Google
// revenue — let the grey `no_match_no_fbclid_or_gclid` bucket surface it.
export const GADS_UNTAGGED_CAMPAIGN_ID = 'gads_untagged';
export const GADS_UNTAGGED_CAMPAIGN_NAME = 'GAds (untagged)';

function extractCampaign(
  click: { extra_params?: Record<string, string>; ad_ids?: AdIds } | undefined
): {
  campaign_id: string;
  source: 'gad_campaignid';
  campaign_name?: string;
} | null {
  if (!click) return null;
  const gad = click.extra_params?.gad_campaignid;
  if (typeof gad === 'string' && gad.trim()) {
    return { campaign_id: gad.trim(), source: 'gad_campaignid' };
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
  // Meta (Facebook) user-data cookies — fbc / fbp. Captured by the controller
  // from the Cookie header (or synthesised from URL fbclid).
  meta_ids?: { fbc?: string; fbp?: string };
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
  meta_ids?: { fbc?: string; fbp?: string };
  ip?: string;
  user_agent?: string;
  referrer?: string;
  country?: string;
}

// Pixel-tracked click. The frontend has already redirected the user and
// supplies BOTH the click_id (it needed it to substitute into the affiliate
// URL) and the redirect_url (the affiliate URL it actually sent the user to).
// `offer` is optional — when the frontend's offer_id doesn't resolve, the
// click is still recorded with `offer_unmapped` so no tracking is lost.
export interface BuildPixelClickInput {
  click_id: string;
  offer_id: string;            // may be '' when the frontend never sent one
  aff_id: string;
  offer: Offer | null;         // null when the offer_id didn't resolve
  redirect_url: string;        // the affiliate URL the user was redirected to
  sub_params: Record<string, string>;
  ad_ids: AdIds;
  extra_params: Record<string, string>;
  meta_ids?: { fbc?: string; fbp?: string };
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
      meta_ids: input.meta_ids,
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
      meta_ids: input.meta_ids,
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

    // Facebook campaign rollup — separate `facebook_campaign_reports` table.
    // Mirrors the GAds extractCampaign block above; runs alongside, never
    // replaces it. fb_untagged synthetic campaign covers clicks with
    // fbclid/fbc/fbp but no campaign tag.
    const fbCampaign = extractFbCampaign(click);
    if (fbCampaign) {
      retry(() =>
        facebookCampaignReportRepository.incrementClick({
          campaign_id: fbCampaign.campaign_id,
          campaign_name: fbCampaign.campaign_name,
          source: fbCampaign.source,
          at: new Date(click.created_at),
          offer_id: click.offer_id,
        })
      ).catch((err: unknown) => {
        logger.warn('fb_campaign_report_click_increment_failed', {
          click_id: click.click_id,
          campaign_id: fbCampaign.campaign_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!campaign && hasAnyUtmParam(click.extra_params)) {
      // Grey bucket — the click carries utm_* tags but no Google identifier
      // (gad_campaignid / gclid / gbraid / wbraid) AND no Facebook identifier
      // (fb_campaign_id / Meta utm_source / fbclid / fbc / fbp). Persisted into
      // facebook_campaign_reports under NO_MATCH_CAMPAIGN_ID so the operator
      // can see leakage; the read-side service strips it from totals on both
      // dashboards so it never inflates either rollup's numbers.
      retry(() =>
        facebookCampaignReportRepository.incrementClick({
          campaign_id: NO_MATCH_CAMPAIGN_ID,
          campaign_name: NO_MATCH_CAMPAIGN_NAME,
          source: 'no_match',
          at: new Date(click.created_at),
          offer_id: click.offer_id,
        })
      ).catch((err: unknown) => {
        logger.warn('no_match_click_increment_failed', {
          click_id: click.click_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Facebook CAPI fan-out — fire only when the click carries a Facebook
    // identifier. Parallel to the GAds dispatch above; never gated by it.
    if (click.ad_ids?.fbclid || click.meta_ids?.fbc || click.meta_ids?.fbp) {
      facebookForwardingService.forgetClick({ click });
    }
  },

  // Builds a click record for the pixel flow. Key differences vs. `build()`:
  //   - click_id comes from the frontend (so the same UUID can be baked into
  //     the affiliate URL's {click_id} placeholder before navigation)
  //   - redirect_url is whatever the frontend actually sent the user to —
  //     NOT a server-rendered template. The DB stores the URL the user really
  //     visited, which is what matters for debugging "where did this click go"
  //   - offer is optional; missing/unresolved offer flags the click as
  //     `offer_unmapped` so the dashboard can surface it for the operator
  buildPixel(input: BuildPixelClickInput): ClickRecord {
    const offerMapped = input.offer !== null && input.offer_id !== '';
    return {
      click_id: input.click_id,
      offer_id: input.offer_id,
      aff_id: input.aff_id,
      sub_params: input.sub_params,
      ad_ids: input.ad_ids,
      meta_ids: input.meta_ids,
      extra_params: input.extra_params,
      ip: input.ip,
      user_agent: input.user_agent,
      referrer: input.referrer,
      country: input.country,
      redirect_url: input.redirect_url,
      source: 'pixel',
      offer_unmapped: !offerMapped,
      warning: offerMapped
        ? undefined
        : input.offer_id === ''
          ? 'offer_id missing on pixel call — add it in the frontend DIRECT_AFFILIATES entry'
          : `offer_id "${input.offer_id}" not found in tracking offers`,
      created_at: new Date().toISOString(),
    };
  },

  // Fire-and-forget persist for pixel clicks. Uses `insertIfAbsent` because
  // the frontend may double-fire (sendBeacon races with image fallback, or
  // a user smashes the button) and we MUST NOT double-count rollups.
  //
  // When the offer is unmapped we still persist the click — the visit is
  // real — but we skip the offer/drilldown/campaign rollups. Those tables
  // are keyed by offer_id; writing a row under an empty/orphan offer_id
  // pollutes the dashboard. The yellow "Unmapped" badge in the clicks list
  // is how the operator sees these and fixes the mapping. Google Ads
  // forwarding runs regardless — gclid attribution doesn't need our
  // internal offer schema.
  persistPixelAsync(click: ClickRecord): void {
    retry(() => clickRepository.insertIfAbsent(click))
      .then((inserted) => {
        if (!inserted) {
          logger.info('pixel_click_duplicate', {
            click_id: click.click_id,
            offer_id: click.offer_id,
          });
          return;
        }

        if (!click.offer_unmapped) {
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
        }

        if (click.ad_ids?.gclid || click.ad_ids?.gbraid || click.ad_ids?.wbraid) {
          googleAdsForwardingService.forgetClick({ click });
        }

        // Facebook campaign rollup (skipped when offer is unmapped, same as
        // the GAds rollup just above — keeps reports keyed by a real offer_id).
        if (!click.offer_unmapped) {
          const fbCampaign = extractFbCampaign(click);
          if (fbCampaign) {
            retry(() =>
              facebookCampaignReportRepository.incrementClick({
                campaign_id: fbCampaign.campaign_id,
                campaign_name: fbCampaign.campaign_name,
                source: fbCampaign.source,
                at: new Date(click.created_at),
                offer_id: click.offer_id,
              })
            ).catch((err: unknown) => {
              logger.warn('fb_campaign_report_click_increment_failed', {
                click_id: click.click_id,
                campaign_id: fbCampaign.campaign_id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            // Grey bucket — see comments in persistAsync.
            const gadsHit = extractCampaign(click);
            if (!gadsHit && hasAnyUtmParam(click.extra_params)) {
              retry(() =>
                facebookCampaignReportRepository.incrementClick({
                  campaign_id: NO_MATCH_CAMPAIGN_ID,
                  campaign_name: NO_MATCH_CAMPAIGN_NAME,
                  source: 'no_match',
                  at: new Date(click.created_at),
                  offer_id: click.offer_id,
                })
              ).catch((err: unknown) => {
                logger.warn('no_match_click_increment_failed', {
                  click_id: click.click_id,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
        }

        // Facebook CAPI fan-out — same rule as GAds: only when there's a
        // Facebook identifier. Runs alongside GAds, not gated by it.
        if (click.ad_ids?.fbclid || click.meta_ids?.fbc || click.meta_ids?.fbp) {
          facebookForwardingService.forgetClick({ click });
        }
      })
      .catch((err: unknown) => {
        logger.error('pixel_click_persist_failed', {
          click_id: click.click_id,
          offer_id: click.offer_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  },
};

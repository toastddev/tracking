import type { ClickRecord } from '../types';
import type { FacebookCampaignSource } from '../firestore/repositories/facebookCampaignReportRepository';

// Facebook campaign attribution — sibling of clickService.extractCampaign for
// the Google Ads path. Kept in a separate file (and writing to a separate
// `facebook_campaign_reports` collection) so the existing GAds extractor and
// the campaign_reports table remain untouched.
//
// Priority:
//   1. extra_params.fb_campaign_id            (operator pipes Meta's
//                                              `{{campaign.id}}` URL macro
//                                              through tracking links)
//   2. extra_params.utm_campaign              (only when utm_source looks
//                                              Facebook-ish, otherwise we'd
//                                              steal credit from other channels)
//   3. fb_untagged (synthetic)                (clicks with fbclid/fbc/fbp but
//                                              no campaign tag)

export const FB_UNTAGGED_CAMPAIGN_ID = 'fb_untagged';
export const FB_UNTAGGED_CAMPAIGN_NAME = 'Facebook (untagged)';

const FB_UTM_SOURCES = new Set([
  'facebook',
  'fb',
  'meta',
  'instagram',
  'ig',
  'messenger',
]);

export interface FbCampaign {
  campaign_id: string;
  campaign_name?: string;        // only set for the synthetic fallback
  source: FacebookCampaignSource;
}

// Accepts either a typed ClickRecord (hot path) or the raw Firestore doc shape
// (backfill path). Returns null when the click is not a Facebook-attributable
// event at all.
export function extractFbCampaign(
  click: Pick<ClickRecord, 'ad_ids' | 'extra_params'> & {
    meta_ids?: { fbc?: string; fbp?: string };
  } | null | undefined
): FbCampaign | null {
  if (!click) return null;

  const extra = click.extra_params ?? {};

  const fbCampaignTag = (extra.fb_campaign_id ?? '').trim();
  if (fbCampaignTag) {
    return { campaign_id: fbCampaignTag, source: 'fb_campaign_id' };
  }

  const utmSource = (extra.utm_source ?? '').toLowerCase().trim();
  const utmCampaign = (extra.utm_campaign ?? '').trim();
  if (utmCampaign && FB_UTM_SOURCES.has(utmSource)) {
    return { campaign_id: utmCampaign, source: 'utm_campaign' };
  }

  // Synthetic fallback — only when the click clearly came from a Facebook ad.
  const fbclid = click.ad_ids?.fbclid;
  const fbc = click.meta_ids?.fbc;
  const fbp = click.meta_ids?.fbp;
  if (fbclid || fbc || fbp) {
    return {
      campaign_id: FB_UNTAGGED_CAMPAIGN_ID,
      campaign_name: FB_UNTAGGED_CAMPAIGN_NAME,
      source: 'fb_campaign_id',
    };
  }

  return null;
}

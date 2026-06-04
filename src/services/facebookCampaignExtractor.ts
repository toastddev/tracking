import type { ClickRecord } from '../types';
import type { FacebookCampaignSource } from '../firestore/repositories/facebookCampaignReportRepository';

// Facebook campaign attribution — sibling of clickService.extractCampaign for
// the Google Ads path. Kept in a separate file (and writing to a separate
// `facebook_campaign_reports` collection) so the existing GAds extractor and
// the campaign_reports table remain untouched.
//
// Priority (highest first):
//   1. extra_params.fb_campaign_id           operator-set explicit Meta campaign id
//
//   2. extra_params.utm_id                   Meta's standard URL Parameters
//                                            template puts the NUMERIC campaign
//                                            id here. Strongly preferred over
//                                            utm_campaign because utm_campaign
//                                            often contains the human-readable
//                                            campaign NAME ("WAYFAIR 8/4 Campaign"),
//                                            which won't join with Insights sync
//                                            (which writes numeric ids).
//
//   3. extra_params.utm_campaign             Used when utm_id is absent. Detect
//                                            numeric (Meta-style) ids vs text
//                                            names — both are valid, but numeric
//                                            ids join with Insights cleanly.
//                                            Text names get stored as
//                                            campaign_name too so the dashboard
//                                            shows something readable until
//                                            sync fills in the canonical name.
//                                            Only matched when utm_source looks
//                                            Facebook-ish so we don't steal
//                                            credit from other channels.
//
//   4. fb_untagged (synthetic)               clicks with fbclid/fbc/fbp but no
//                                            campaign tag — keeps revenue
//                                            attributed to Meta at the aggregate
//                                            level even without a campaign id.

export const FB_UNTAGGED_CAMPAIGN_ID = 'fb_untagged';
export const FB_UNTAGGED_CAMPAIGN_NAME = 'Facebook (untagged)';

// Meta's `site_source_name` macro emits one of these. Anything else means the
// click didn't come from Meta and we shouldn't claim it.
export const FB_UTM_SOURCES = new Set([
  'facebook',
  'fb',
  'meta',
  'instagram',
  'ig',
  'messenger',
  'msg',
  'an',           // Audience Network
]);

// Meta campaign / ad ids are 15-17 digit numbers (current shape; their internal
// counter sometimes flips up to 18 in edge cases). Used to tell a numeric
// utm_campaign apart from a text one.
const META_ID_RE = /^\d{10,20}$/;

export interface FbCampaign {
  campaign_id: string;
  campaign_name?: string;
  source: FacebookCampaignSource;
}

export function extractFbCampaign(
  click: Pick<ClickRecord, 'ad_ids' | 'extra_params'> & {
    meta_ids?: { fbc?: string; fbp?: string };
  } | null | undefined
): FbCampaign | null {
  if (!click) return null;
  const extra = click.extra_params ?? {};

  // 1. Operator-set explicit Meta campaign id — always trusted.
  const fbCampaignTag = (extra.fb_campaign_id ?? '').trim();
  if (fbCampaignTag) {
    return { campaign_id: fbCampaignTag, source: 'fb_campaign_id' };
  }

  const utmSource = (extra.utm_source ?? '').toLowerCase().trim();
  const utmId = (extra.utm_id ?? '').trim();
  const utmCampaign = (extra.utm_campaign ?? '').trim();
  const fromMetaUtm = utmSource && FB_UTM_SOURCES.has(utmSource);

  // 2. utm_id — Meta's canonical numeric campaign id. Preferred over
  //    utm_campaign because it's reliably the id, not the name.
  if (fromMetaUtm && utmId && META_ID_RE.test(utmId)) {
    return {
      campaign_id: utmId,
      source: 'utm_id',
      // utm_campaign often carries the friendly name — surface it as the
      // display name until the next Insights sync overwrites with canonical.
      campaign_name: utmCampaign && !META_ID_RE.test(utmCampaign) ? utmCampaign : undefined,
    };
  }

  // 3. utm_campaign fallback. Same as before, but we now record campaign_name
  //    when the value is text so the dashboard doesn't show raw "WAYFAIR 8/4"
  //    as the "id" column.
  if (fromMetaUtm && utmCampaign) {
    const isNumeric = META_ID_RE.test(utmCampaign);
    return {
      campaign_id: utmCampaign,
      source: 'utm_campaign',
      campaign_name: isNumeric ? undefined : utmCampaign,
    };
  }

  // 4. Synthetic fallback — clicks with Meta identifiers but no campaign tag.
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

// Used by the CAPI forwarder to decide whether to send events for a click
// that has no fbclid/fbc/fbp. If utm_source is a Meta source, Meta CAPI
// accepts IP+UA as a (lower-match-quality) signal and still attributes the
// event server-side. Without this, we silently drop a meaningful share of
// Meta traffic on iOS + in-app browsers + Audience Network placements where
// fbclid is stripped.
export function isMetaUtmSource(
  extra_params: Record<string, string> | undefined
): boolean {
  const utmSource = (extra_params?.utm_source ?? '').toLowerCase().trim();
  return utmSource !== '' && FB_UTM_SOURCES.has(utmSource);
}

// True when the click carries at least one utm_* parameter with a non-empty
// value. Used to gate the grey `no_match_no_fbclid_or_gclid` bucket — a click
// with zero UTM tracking has nothing to attribute and shouldn't pollute the
// grey row.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content'] as const;
export function hasAnyUtmParam(extra_params: Record<string, string> | undefined): boolean {
  if (!extra_params) return false;
  for (const k of UTM_KEYS) {
    const v = extra_params[k];
    if (typeof v === 'string' && v.trim()) return true;
  }
  return false;
}

// Raw-doc variant for the reconciler (Firestore docs come in as Record<string, unknown>).
export function hasAnyUtmParamRaw(extra: unknown): boolean {
  if (!extra || typeof extra !== 'object') return false;
  const e = extra as Record<string, unknown>;
  for (const k of UTM_KEYS) {
    const v = e[k];
    if (typeof v === 'string' && v.trim()) return true;
  }
  return false;
}

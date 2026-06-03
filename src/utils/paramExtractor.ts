import type { AdIds } from '../types';

const AD_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] as const;
const AD_KEY_SET = new Set<string>(AD_KEYS);
const SUB_PATTERN = /^s\d+$/;
// Built-in tracking params that are handled separately. Anything else lands
// in extra_params so we never silently drop a custom UTM / partner key.
const RESERVED_KEYS = new Set<string>(['offer_id', 'aff_id']);
// Cap a single extra value to keep one rogue caller from blowing up Firestore
// (1MB doc limit). 1KB per value × ~50 keys still leaves plenty of headroom.
const MAX_VALUE_LEN = 1024;
const MAX_EXTRA_KEYS = 50;

export function extractSubParams(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(query)) {
    if (SUB_PATTERN.test(key) && query[key]) out[key] = query[key];
  }
  return out;
}

export function extractAdIds(query: Record<string, string>): AdIds {
  const out: AdIds = {};
  for (const key of AD_KEYS) {
    if (query[key]) out[key] = query[key];
  }
  return out;
}

// Catch-all for anything not already captured by the structured extractors:
// utm_source / utm_campaign / utm_medium, pid, cmpid, partner-specific keys,
// etc. Reserved/known keys are excluded so we don't duplicate them on the
// wire. Bounded for safety — see MAX_EXTRA_KEYS / MAX_VALUE_LEN above.
export function extractExtraParams(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(query)) {
    if (count >= MAX_EXTRA_KEYS) break;
    if (RESERVED_KEYS.has(key)) continue;
    if (AD_KEY_SET.has(key)) continue;
    if (SUB_PATTERN.test(key)) continue;
    const value = query[key];
    if (value == null || value === '') continue;
    out[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) : value;
    count++;
  }
  return out;
}

export function resolveClientIp(headers: {
  get: (k: string) => string | undefined;
}): string | undefined {
  return (
    headers.get('cf-connecting-ip') ||
    headers.get('x-real-ip') ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  );
}

// ── Meta (Facebook) identifiers ────────────────────────────────────
// Reads `_fbc` / `_fbp` from the request cookies. If `_fbc` is absent but the
// URL contains `fbclid`, synthesise the canonical cookie form per Meta's spec:
//   _fbc = fb.1.<unix_ms>.<fbclid>
// `_fbp` is never synthesised server-side — doing so produces fake user
// identifiers that hurt CAPI match quality. Only set what the browser
// actually sent.
//
// Returns the parsed/synthesised values AND a list of cookies the caller
// should Set-Cookie back to the client (so the same value round-trips on the
// next visit and Meta sees a stable identifier).

export interface MetaIds {
  fbc?: string;
  fbp?: string;
}

export interface MetaIdResult {
  meta_ids: MetaIds;
  // Cookies to Set-Cookie back. Empty when nothing was synthesised — we never
  // re-emit cookies the browser already had.
  set_cookies: Array<{ name: '_fbc' | '_fbp'; value: string }>;
}

function parseCookieHeader(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function extractMetaIds(query: Record<string, string>, cookieHeader: string | undefined): MetaIdResult {
  const cookies = parseCookieHeader(cookieHeader);
  const out: MetaIds = {};
  const setCookies: MetaIdResult['set_cookies'] = [];

  // Existing cookies take precedence — they're the canonical Meta-set values.
  if (cookies._fbc) out.fbc = cookies._fbc;
  if (cookies._fbp) out.fbp = cookies._fbp;

  // Synthesise `_fbc` from a URL `fbclid` only if the cookie is absent. Per
  // Meta's spec the first dot-separated field is `fb`, then version 1, then
  // the click timestamp in ms, then the fbclid value verbatim.
  if (!out.fbc && query.fbclid) {
    const synth = `fb.1.${Date.now()}.${query.fbclid}`;
    out.fbc = synth;
    setCookies.push({ name: '_fbc', value: synth });
  }

  return { meta_ids: out, set_cookies: setCookies };
}

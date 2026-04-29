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

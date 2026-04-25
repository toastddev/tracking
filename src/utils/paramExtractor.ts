import type { AdIds } from '../types';

const AD_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] as const;
const SUB_PATTERN = /^s\d+$/;

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

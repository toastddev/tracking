export function isNonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export type ParamCheck = { ok: true } | { ok: false; missing: string[] };

export function requireParams(
  source: Record<string, string | undefined>,
  required: readonly string[]
): ParamCheck {
  const missing = required.filter((k) => !isNonEmpty(source[k]));
  return missing.length ? { ok: false, missing } : { ok: true };
}

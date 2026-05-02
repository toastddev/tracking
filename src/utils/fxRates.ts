// Currency conversion for Google Ads spend (cost_micros is reported in the
// account's local currency). The dashboard standardises on USD, so any non-USD
// account spend is converted before persistence.
//
// Configure via the `GOOGLE_ADS_FX_RATES` env var as a comma-separated list of
// `<CODE>:<units-per-USD>` pairs, e.g. `INR:93,EUR:0.92`. Higher values mean
// "weaker" currencies; conversion is `local / rate`. USD is implicit (rate=1).
//
// Default: `INR:93` — operator-set baseline. Update the env when the rate
// drifts enough to matter; live FX would add a runtime dep for ~1% daily noise.

const DEFAULT_RATES: Record<string, number> = { INR: 93 };

let cached: Record<string, number> | null = null;

function parseRates(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_RATES };
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [codeRaw, valRaw] = part.split(':');
    const code = (codeRaw ?? '').trim().toUpperCase();
    const val = Number((valRaw ?? '').trim());
    if (!code) continue;
    if (Number.isFinite(val) && val > 0) out[code] = val;
  }
  return out;
}

export function fxRates(): Record<string, number> {
  if (!cached) cached = parseRates(process.env.GOOGLE_ADS_FX_RATES);
  return cached;
}

// Test-only: clear the cache so a freshly-set env var is re-read.
export function __resetFxRatesCacheForTests(): void {
  cached = null;
}

// Convert `amount` from `currency` to USD. Pass-through when the currency is
// USD/empty. Returns null when no rate is configured — the caller should log
// once and treat the value as untrusted (not silently mislabel it as USD).
export function toUsd(amount: number, currency: string | undefined): number | null {
  const code = (currency ?? '').toUpperCase().trim();
  if (!code || code === 'USD') return amount;
  const rate = fxRates()[code];
  if (!rate || rate <= 0) return null;
  return amount / rate;
}

// Currency handling for the whole tracking stack.
//
// Two distinct jobs live here:
//
//   1. NORMALISATION — turn whatever string a network sent ("cny", "RMB", "¥",
//      "", undefined) into a valid ISO-4217 code, or `null` when it can't be
//      trusted. Nothing downstream should ever hand a raw network string to
//      Google/Meta or use it as a conversion key.
//   2. CONVERSION — move an amount between currencies using the rate table,
//      pivoting through USD.
//
// The rates themselves live in ./fxRates.constants.ts — edit that file to
// change a rate. There is no env override: a second source could silently
// shadow the file and make an edit there look like it did nothing.
//
// The table is fixed rather than fetched live, on purpose. Stored rollups are
// denominated at WRITE time, so a rate that moves between a write and a
// backfill would silently rewrite history — re-running `npm run recalc` would
// change last month's reported revenue. A fixed table also keeps the dashboard
// and the ad platforms showing the same number.

import {
  FX_RATES,
  BASE_CURRENCY,
  CURRENCY_ALIASES,
  FALLBACK_CONVERSION_CURRENCY,
} from './fxRates.constants';

/**
 * The configured rate table: units of each currency per 1 USD.
 * Frozen — callers read, never mutate.
 */
export function fxRates(): Readonly<Record<string, number>> {
  return FX_RATES;
}

// ── normalisation ────────────────────────────────────────────────────

/**
 * Coerce an arbitrary network-supplied currency string to a valid ISO-4217
 * code, or `null` when it isn't usable.
 *
 * Returning `null` (rather than silently defaulting to USD) is the whole
 * point: a missing currency treated as USD is how a ¥120 AliExpress payout
 * became ₹11,160 on upload. Callers must decide explicitly what to do with
 * `null` — see `resolveConversionCurrency`.
 */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  // Strip symbols/digits/whitespace so "¥", "USD ", and "usd" all behave.
  const code = (raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!code) return null;
  const iso = CURRENCY_ALIASES[code] ?? code;
  return /^[A-Z]{3}$/.test(iso) ? iso : null;
}

/**
 * The currency to assume when a conversion carries no usable currency of its
 * own and its network has no configured default. Set in fxRates.constants.ts
 * so the assumption is stated in one visible place rather than hardcoded at
 * every call site.
 */
export function defaultConversionCurrency(): string {
  return normalizeCurrency(FALLBACK_CONVERSION_CURRENCY) ?? 'USD';
}

export interface ResolvedCurrency {
  currency: string;
  /** Where the code came from — lets callers warn only on the risky path. */
  source: 'payload' | 'network_default' | 'global_default';
}

/**
 * Resolve the currency for one conversion, in priority order:
 *   1. what the network sent on the row
 *   2. the network's / affiliate API's configured `default_currency`
 *   3. the global `DEFAULT_CONVERSION_CURRENCY` (USD unless overridden)
 *
 * Always returns a valid code, so every downstream consumer (reports,
 * Google Ads, Meta) can rely on `conversion.currency` being trustworthy.
 * `source` is returned so ingestion can log the `global_default` case — that's
 * the one that silently mis-prices a non-USD network.
 */
export function resolveConversionCurrency(
  payloadCurrency: string | null | undefined,
  networkDefault?: string | null,
): ResolvedCurrency {
  const fromPayload = normalizeCurrency(payloadCurrency);
  if (fromPayload) return { currency: fromPayload, source: 'payload' };

  const fromNetwork = normalizeCurrency(networkDefault);
  if (fromNetwork) return { currency: fromNetwork, source: 'network_default' };

  return { currency: defaultConversionCurrency(), source: 'global_default' };
}

/** Units of `code` per 1 USD, or null when the table has no entry. */
export function rateFor(code: string | null | undefined): number | null {
  const iso = normalizeCurrency(code);
  if (!iso) return null;
  // The pivot currency is implicit and must never be listed in the table.
  if (iso === BASE_CURRENCY) return 1;
  const rate = FX_RATES[iso];
  return rate && rate > 0 ? rate : null;
}

/** True when `code` is a valid ISO code we can convert to/from. */
export function hasRate(code: string | null | undefined): boolean {
  return rateFor(code) !== null;
}

// ── conversion ───────────────────────────────────────────────────────

/**
 * Convert between any two currencies. Rates are `<units per USD>`, so every
 * conversion pivots through USD.
 *
 * Returns null when either side is unidentifiable or has no configured rate.
 * Note it does NOT fall back to a default currency: an amount whose currency
 * we can't name is genuinely unknown, and guessing is how wrong money gets
 * written. Callers that have a legitimate default resolve it first — see
 * `resolveConversionCurrency`.
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string | undefined,
  toCurrency: string | undefined,
): { amount: number; currency: string } | null {
  if (!Number.isFinite(amount)) return null;

  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency) ?? from;
  if (!from || !to) return null;
  if (from === to) return { amount, currency: to };

  const fromRate = rateFor(from);
  const toRate = rateFor(to);
  if (fromRate === null || toRate === null) return null;

  const usd = amount / fromRate;
  return {
    amount: Number((usd * toRate).toFixed(6)),
    currency: to,
  };
}

/**
 * Convert `amount` to USD — the canonical currency for offer / postback
 * reports. Returns null when the currency is unknown or has no rate.
 */
export function toUsd(amount: number, currency: string | undefined): number | null {
  const converted = convertCurrency(amount, currency, 'USD');
  return converted ? converted.amount : null;
}

/**
 * Convert `amount` to INR — the canonical currency for campaign reports and
 * all Google Ads / Meta spend metrics. Returns null when no rate is available.
 */
export function toInr(amount: number, currency: string | undefined): number | null {
  const converted = convertCurrency(amount, currency, 'INR');
  return converted ? converted.amount : null;
}

// ── upload money ─────────────────────────────────────────────────────

export type UploadMoney =
  | {
      /** Converted on our side — upload `value` labelled `currency`. */
      ok: true;
      value: number;
      currency: string;
      converted: boolean;
    }
  | {
      /** Valid currency, but no rate configured. Upload the raw source value
       *  labelled with its true source currency and let the ad platform apply
       *  its own daily rate. Approximately right, and never mislabelled. */
      ok: false;
      value: number;
      currency: string;
      reason: 'no_rate';
    };

/**
 * Work out what money to put on an outbound Google Ads / Meta conversion.
 *
 * The invariant that matters: **the number and the currency label always
 * agree**. Ad platforms convert only when the label differs from the account
 * currency, so a correct label is never harmful — but a value scaled to one
 * currency and tagged as another is silently, unfixably wrong (that is the
 * bug that made uploads read ₹120 instead of ₹11,160).
 *
 * When the rate table can convert, we do it ourselves so the dashboard and the
 * ad platform show identical numbers. When it can't, we degrade to shipping
 * the source currency honestly rather than guessing.
 */
export function resolveUploadMoney(
  amount: number,
  sourceCurrency: string | undefined,
  targetCurrency: string | undefined,
): UploadMoney {
  const source = normalizeCurrency(sourceCurrency) ?? defaultConversionCurrency();
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const target = normalizeCurrency(targetCurrency) ?? source;

  const converted = convertCurrency(safeAmount, source, target);
  if (converted) {
    return {
      ok: true,
      value: converted.amount,
      currency: converted.currency,
      converted: converted.currency !== source,
    };
  }

  return { ok: false, value: safeAmount, currency: source, reason: 'no_rate' };
}

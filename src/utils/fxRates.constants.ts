// ─────────────────────────────────────────────────────────────────────────
//  CURRENCY CONFIGURATION — the single place rates live.
//
//  Edit THIS FILE to change an exchange rate. There is no env override:
//  `GOOGLE_ADS_FX_RATES` was removed deliberately, because having two sources
//  meant an env var could silently shadow the file and make an edit here look
//  like it did nothing.
//
//  Everything monetary in the stack reads these values — campaign report
//  revenue (INR), offer / postback / drilldown revenue (USD), ad-platform
//  spend, and the conversion values uploaded to Google Ads and Meta.
// ─────────────────────────────────────────────────────────────────────────

/** The pivot. Every conversion goes local → USD → target. */
export const BASE_CURRENCY = 'USD';

/**
 * Rates are **units of the currency per 1 USD**. Higher number = weaker
 * currency. USD itself is implicit (rate 1) and must not be listed.
 *
 *   INR: 93   →  1 USD  = 93 INR
 *   CNY: 7.7  →  1 USD  = 7.7 CNY
 *
 * ── Cross-rates are DERIVED, never configured ──────────────────────────
 * There is no CNY→INR entry; it falls out of the two rates above:
 *
 *   1 CNY = 93 / 7.7 = ~12.08 INR
 *
 * So to change what a currency is worth in rupees, change THAT currency's
 * rate. Changing INR:93 moves every currency at once, because INR is on the
 * bottom of every cross-rate.
 *
 * ── Adding a network in a new currency ─────────────────────────────────
 * Add its ISO-4217 code here with its units-per-USD rate. Until you do, that
 * network's revenue is dropped from reports and its conversions upload
 * unconverted (labelled in the source currency, so the ad platform converts
 * at its own daily rate — approximate, never wrong-by-mislabelling).
 * A throttled `*_fx_missing` warning names any code that is missing.
 *
 * ── A note on the INR figure ───────────────────────────────────────────
 * INR:93 is an inherited baseline that sits above spot. Because USD revenue
 * is displayed in INR, a rate above spot makes reported INR revenue larger,
 * and spend is already natively INR — so it inflates reported profit.
 * Every other entry below is set to approximate spot, so INR is the one
 * currency on a different basis. Bringing it to spot is a separate decision:
 * it would move every historical INR number, so it needs a deliberate
 * `npm run recalc` afterwards.
 *
 * ── ⚠ VERIFY BEFORE YOU RELY ON ONE ────────────────────────────────────
 * These are approximate reference values, NOT a live feed. Before taking
 * payouts in a currency, check its rate against a real source and correct it
 * here. A stale rate does not fail loudly — it quietly mis-prices revenue.
 * Currencies are grouped by how fast they drift; see RATES_REVIEWED_ON.
 */

/**
 * When a human last checked these rates against a real source. Bump this
 * whenever you revise the table — it's the only signal of staleness, since a
 * wrong rate produces plausible-looking numbers rather than an error.
 */
export const RATES_REVIEWED_ON = '2026-08-13';

export const FX_RATES: Readonly<Record<string, number>> = Object.freeze({
  // ── House basis ──────────────────────────────────────────────────────
  // Deliberately above spot — see the note above before changing.
  INR: 93,

  // ── Hard-pegged to USD ───────────────────────────────────────────────
  // These barely move; safe to leave for long stretches.
  AED: 3.6725,  // UAE dirham — pegged
  SAR: 3.75,    // Saudi riyal — pegged
  QAR: 3.64,    // Qatari riyal — pegged
  BHD: 0.376,   // Bahraini dinar — pegged
  OMR: 0.3845,  // Omani rial — pegged
  HKD: 7.8,     // Hong Kong dollar — tight band
  KWD: 0.307,   // Kuwaiti dinar — basket peg, drifts slightly

  // ── Major floats ─────────────────────────────────────────────────────
  // Drift slowly (a few % a year). Review a couple of times a year.
  EUR: 0.92,
  GBP: 0.79,
  CHF: 0.88,
  CAD: 1.37,
  AUD: 1.52,
  NZD: 1.66,
  JPY: 155,
  CNY: 7.7,     // AliExpress pays in this — see default_currency on that API
  SGD: 1.34,
  SEK: 10.5,
  NOK: 10.8,
  DKK: 6.9,
  PLN: 3.95,
  CZK: 23,
  RON: 4.6,
  ILS: 3.7,
  KRW: 1380,
  TWD: 32.5,

  // ── Emerging / regional ──────────────────────────────────────────────
  // Move faster. Review before running meaningful volume through one.
  THB: 34,
  MYR: 4.4,
  IDR: 15800,
  PHP: 58,
  VND: 25400,
  BRL: 5.6,
  MXN: 18,
  CLP: 950,
  COP: 4200,
  ZAR: 18.5,
  PKR: 278,
  BDT: 120,
  LKR: 295,
  NPR: 134,     // soft-pegged to INR at ~1.6 NPR per INR
  HUF: 360,
  KZT: 490,

  // ── Volatile — check these EVERY time before use ─────────────────────
  // Capable of moving 20%+ within a year. A stale figure here is not a
  // rounding error, it's a materially wrong revenue number.
  TRY: 34,      // Turkish lira — persistent depreciation
  NGN: 1550,    // Nigerian naira — post-devaluation, unstable
  EGP: 49,      // Egyptian pound — post-devaluation
  RUB: 92,      // Russian rouble — sanctions-driven swings
  UAH: 41,      // Ukrainian hryvnia
  KES: 129,     // Kenyan shilling

  // Deliberately NOT listed: ARS, VES, LBP and similar hyperinflationary
  // currencies. Any hardcoded figure would be wrong within weeks, and a
  // missing rate is the safer failure — revenue is skipped with a loud
  // `*_fx_missing` warning instead of being silently mis-priced by 10x.
  // If you ever take payouts in one, price the payout in USD upstream.
});

/**
 * Currency assumed for a conversion when the network sends none AND the
 * network / affiliate API has no `default_currency` configured.
 *
 * This is a last-resort fallback — prefer setting `default_currency` on the
 * network itself, because a wrong assumption here silently mis-prices every
 * conversion that network sends. Falling through to it emits a one-time
 * warning naming the network.
 */
export const FALLBACK_CONVERSION_CURRENCY = 'USD';

/**
 * Non-ISO strings networks actually send in the wild, mapped to the real
 * ISO-4217 code. Keys are matched after upper-casing and stripping every
 * non-letter, so "rmb", "RMB " and "Rmb" all resolve to CNY.
 *
 * CNH (offshore yuan) is folded into CNY on purpose — we don't track the
 * onshore/offshore spread.
 *
 * ── Only unambiguous names belong here ─────────────────────────────────
 * Deliberately absent: "PESO" (MXN? ARS? PHP? CLP?), "RIYAL" (SAR? QAR?),
 * "DOLLAR" on its own is kept for USD only because that's overwhelmingly
 * what a network means, but "CROWN"/"KRONA" (SEK? NOK? DKK? CZK?) and
 * "SHILLING" (KES? UGX? TZS?) are left out. Guessing wrong here silently
 * prices a payout in the wrong country's currency — a missing alias just
 * falls through to the network's default_currency, which is recoverable.
 */
export const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Chinese yuan
  RMB: 'CNY',
  CNH: 'CNY',
  YUAN: 'CNY',
  // Indian rupee. NOTE: PKR / LKR / NPR are also called "rupee" — INR wins
  // here because it's the house currency. A network paying in Pakistani
  // rupees must set default_currency=PKR explicitly.
  RS: 'INR',
  RUPEE: 'INR',
  RUPEES: 'INR',
  // US dollar
  DOLLAR: 'USD',
  DOLLARS: 'USD',
  USDOLLAR: 'USD',
  // Euro
  EURO: 'EUR',
  EUROS: 'EUR',
  // Pound sterling
  POUND: 'GBP',
  POUNDS: 'GBP',
  STERLING: 'GBP',
  // Japanese yen
  YEN: 'JPY',
  // Names that map to exactly one currency in circulation
  REAL: 'BRL',
  REAIS: 'BRL',
  RINGGIT: 'MYR',
  BAHT: 'THB',
  RUPIAH: 'IDR',
  WON: 'KRW',
  TAKA: 'BDT',
  DONG: 'VND',
  ZLOTY: 'PLN',
  RAND: 'ZAR',
  // NOT mapped, on purpose: "LIRA" (TRY vs LBP) and "DIRHAM" (AED vs MAD).
  // Both are genuinely ambiguous — set default_currency on the network.
});

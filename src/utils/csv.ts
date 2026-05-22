// RFC-4180-ish CSV cell escape. Wrap in double-quotes when the value contains
// a quote, comma, or newline; double up embedded quotes.
//
// Shared between the clicks export (adminController) and the Google Ads
// uploads export (googleAdsController) so a future tweak — e.g. tightening
// quoting rules to match Excel's stricter parser — only needs to happen once.
export function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

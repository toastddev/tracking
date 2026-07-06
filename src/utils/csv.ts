// RFC-4180-ish CSV cell escape. Wrap in double-quotes when the value contains
// a quote, comma, or newline; double up embedded quotes.
//
// Shared between the clicks export (adminController) and the Google Ads
// uploads export (googleAdsController) so a future tweak — e.g. tightening
// quoting rules to match Excel's stricter parser — only needs to happen once.
//
// Formula-injection guard: spreadsheet apps (Excel / Google Sheets / LibreOffice)
// treat a cell whose text begins with '=', '+', '-', '@', or a leading tab/CR as
// a formula and will execute it on open. Our exports embed attacker-controlled
// fields (referrer, user_agent, redirect_url), so a value like `=HYPERLINK(...)`
// would run on the operator's machine. We neutralise it by prefixing a single
// quote, which forces the cell to be read as literal text.
export function csvEscape(v: unknown): string {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

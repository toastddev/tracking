// Referer blocklist for the /click redirect endpoint.
//
// blocklist.json holds apex domains we never want to redirect traffic from
// (Facebook / Google families today). It's imported — not read per request —
// so it's loaded into memory exactly once when this module is first evaluated.
// Editing the JSON requires a process restart.
//
// Performance: every click does at most ~4 Set lookups (one per domain label)
// plus a single URL parse. No I/O, no async, no allocation beyond the parse.

import blocklist from '../blocklist.json';

const blockedDomains: ReadonlySet<string> = new Set(
  blocklist.blockedReferrerDomains.map((d) => d.toLowerCase())
);

// True when `referer` resolves to a blocked domain or any of its subdomains.
// An absent or unparseable Referer is treated as allowed — those clicks
// redirect normally.
export function isRefererBlocked(referer: string | undefined | null): boolean {
  if (!referer) return false;

  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;

  // Walk from the most-specific name to its apex: m.facebook.com →
  // facebook.com → com. First hit wins.
  if (blockedDomains.has(host)) return true;
  let dot = host.indexOf('.');
  while (dot !== -1) {
    if (blockedDomains.has(host.slice(dot + 1))) return true;
    dot = host.indexOf('.', dot + 1);
  }
  return false;
}

// Minimal self-contained error page shown to blocked visitors. No external
// assets so it renders instantly.
export const BLOCKED_REFERER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Access blocked</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
       font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:#0f1115;color:#e6e6e6}
  .card{max-width:420px;padding:32px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:14px;line-height:1.6;color:#9aa0a6;margin:0}
</style>
</head>
<body>
  <div class="card">
    <h1>This link can't be opened from here</h1>
    <p>Access from this source is not allowed. Please open the link in your browser directly.</p>
  </div>
</body>
</html>`;

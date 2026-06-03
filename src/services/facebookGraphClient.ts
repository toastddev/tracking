// Thin Meta Graph API client. Mirrors the role of ./googleAdsClient.ts — keeps
// all HTTP / env / URL-building logic out of the OAuth/account/sync services.
// We use built-in fetch (Node 20+) rather than a heavy SDK because Meta's
// Marketing + CAPI surface area we touch is small and SDK installs are
// notoriously chunky.

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function readEnvOptional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const META = {
  apiVersion(): string {
    return readEnvOptional('META_API_VERSION', 'v21.0');
  },
  graphBase(): string {
    // Trailing slash stripped so we can join safely.
    return readEnvOptional('META_GRAPH_BASE_URL', 'https://graph.facebook.com').replace(/\/+$/, '');
  },
  appId(): string {
    return readEnv('META_APP_ID');
  },
  appSecret(): string {
    return readEnv('META_APP_SECRET');
  },
  redirectUri(): string {
    return readEnv('META_OAUTH_REDIRECT');
  },
};

export function buildGraphUrl(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  // path can be `me`, `<id>`, `<id>/ad_accounts`, etc. We always namespace it
  // under the API version so callers don't have to.
  const versioned = `/${META.apiVersion()}${cleanPath}`;
  const url = new URL(`${META.graphBase()}${versioned}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Mirror Meta's standard error shape. Surfaced verbatim to the caller so the
// retry / kill-the-connection logic in facebookForwardingService can match on
// `error.code` (190 = OAuth, 102/200/2500 = permission, etc.).
export class FacebookGraphError extends Error {
  readonly httpStatus: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly body: unknown;

  constructor(opts: {
    httpStatus: number;
    body: unknown;
    message: string;
    code?: number;
    subcode?: number;
    type?: string;
    fbtraceId?: string;
  }) {
    super(opts.message);
    this.name = 'FacebookGraphError';
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.type = opts.type;
    this.fbtraceId = opts.fbtraceId;
    this.body = opts.body;
  }
}

function parseGraphError(httpStatus: number, body: unknown): FacebookGraphError {
  const root = (body as { error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string } })?.error;
  return new FacebookGraphError({
    httpStatus,
    body,
    message: root?.message ?? `meta_graph_http_${httpStatus}`,
    code: typeof root?.code === 'number' ? root.code : undefined,
    subcode: typeof root?.error_subcode === 'number' ? root.error_subcode : undefined,
    type: root?.type,
    fbtraceId: root?.fbtrace_id,
  });
}

// Single internal GET runner. Returns parsed JSON or throws FacebookGraphError.
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) throw parseGraphError(res.status, body);
  return body as T;
}

// Single internal POST runner. Body is sent as JSON; Meta's CAPI accepts this
// form and avoids the multipart edge cases of x-www-form-urlencoded.
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!res.ok) throw parseGraphError(res.status, parsed);
  return parsed as T;
}

export const facebookGraphApi = {
  get: getJson,
  post: postJson,

  // Exchanges a short-lived user token for a long-lived (~60d) one. Meta
  // returns { access_token, token_type, expires_in } — expires_in is in
  // seconds from now.
  async exchangeShortForLongLivedUserToken(shortToken: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const url = buildGraphUrl('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: META.appId(),
      client_secret: META.appSecret(),
      fb_exchange_token: shortToken,
    });
    return await getJson(url);
  },

  // The first leg of OAuth: trade `code` for the initial short-lived token.
  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const url = buildGraphUrl('/oauth/access_token', {
      client_id: META.appId(),
      client_secret: META.appSecret(),
      redirect_uri: META.redirectUri(),
      code,
    });
    return await getJson(url);
  },

  async meEmail(accessToken: string): Promise<{ id: string; name?: string; email?: string }> {
    const url = buildGraphUrl('/me', {
      fields: 'id,name,email',
      access_token: accessToken,
    });
    return await getJson(url);
  },

  // BMs the authenticated user can administer. Used by the picker.
  async listBusinesses(accessToken: string): Promise<Array<{
    id: string;
    name: string;
    primary_page?: string;
    verification_status?: string;
  }>> {
    const url = buildGraphUrl('/me/businesses', {
      fields: 'id,name,primary_page,verification_status',
      access_token: accessToken,
      limit: 100,
    });
    const res = await getJson<{ data?: Array<{ id: string; name: string; primary_page?: string; verification_status?: string }> }>(url);
    return res.data ?? [];
  },

  // Ad accounts the authenticated user can manage directly (NOT via a BM).
  // We need both this and listBusinesses so an operator without BM access can
  // still connect a personal ad account.
  async listOwnedAdAccounts(accessToken: string): Promise<Array<AdAccountSummary>> {
    const url = buildGraphUrl('/me/adaccounts', {
      fields: 'account_id,id,name,currency,timezone_name,account_status,business',
      access_token: accessToken,
      limit: 200,
    });
    const res = await getJson<{ data?: AdAccountRaw[] }>(url);
    return (res.data ?? []).map(normaliseAdAccount);
  },

  // Ad accounts owned by a specific BM. Combined with client_ad_accounts to
  // get the full picture for that BM.
  async listAdAccountsForBusiness(accessToken: string, businessId: string): Promise<Array<AdAccountSummary>> {
    const fields = 'account_id,id,name,currency,timezone_name,account_status';
    const owned = await getJson<{ data?: AdAccountRaw[] }>(
      buildGraphUrl(`/${businessId}/owned_ad_accounts`, {
        fields,
        access_token: accessToken,
        limit: 200,
      })
    );
    const client = await getJson<{ data?: AdAccountRaw[] }>(
      buildGraphUrl(`/${businessId}/client_ad_accounts`, {
        fields,
        access_token: accessToken,
        limit: 200,
      })
    ).catch(() => ({ data: [] as AdAccountRaw[] }));   // permission-scoped BMs may reject
    const merged = [...(owned.data ?? []), ...(client.data ?? [])].map((raw) => ({
      ...normaliseAdAccount(raw),
      business_id: businessId,
    }));
    return dedupeAdAccountsById(merged);
  },

  async getAdAccountMetadata(accessToken: string, adAccountId: string): Promise<AdAccountSummary | null> {
    try {
      const raw = await getJson<AdAccountRaw>(
        buildGraphUrl(`/${adAccountId}`, {
          fields: 'account_id,id,name,currency,timezone_name,account_status,business',
          access_token: accessToken,
        })
      );
      return normaliseAdAccount(raw);
    } catch {
      return null;
    }
  },

  async getBusinessMetadata(accessToken: string, businessId: string): Promise<{ id: string; name: string } | null> {
    try {
      const raw = await getJson<{ id: string; name?: string }>(
        buildGraphUrl(`/${businessId}`, {
          fields: 'id,name',
          access_token: accessToken,
        })
      );
      return { id: String(raw.id), name: String(raw.name ?? '') };
    } catch {
      return null;
    }
  },

  // Datasets (pixels) attached to an ad account. CAPI events POST against a
  // dataset_id, so the operator picks one per connection (or per route).
  async listDatasetsForAdAccount(accessToken: string, adAccountId: string): Promise<Array<{ id: string; name: string }>> {
    // Meta exposes the legacy alias `adspixels`. `dataset_id` ≡ pixel id.
    const url = buildGraphUrl(`/${adAccountId}/adspixels`, {
      fields: 'id,name',
      access_token: accessToken,
      limit: 100,
    });
    try {
      const res = await getJson<{ data?: Array<{ id: string; name?: string }> }>(url);
      return (res.data ?? []).map((d) => ({ id: String(d.id), name: String(d.name ?? '') }));
    } catch {
      return [];
    }
  },

  // Custom events registered against a dataset. Combined with the always-on
  // Meta standard events ('Purchase', 'Lead', …) for the dropdown the operator
  // picks `sale_event_name` from.
  async listCustomEventsForDataset(accessToken: string, datasetId: string): Promise<Array<{ name: string; description?: string }>> {
    const url = buildGraphUrl(`/${datasetId}/da_custom_audiences`, {
      // Meta keeps custom-event metadata under several edges; we read the
      // simpler `custom_conversions` edge instead which is the operator-facing
      // surface inside Events Manager.
      fields: 'name',
      access_token: accessToken,
      limit: 100,
    }).replace('da_custom_audiences', 'customconversions');
    try {
      const res = await getJson<{ data?: Array<{ name?: string; description?: string }> }>(url);
      return (res.data ?? [])
        .filter((e) => typeof e.name === 'string' && e.name.length > 0)
        .map((e) => ({ name: String(e.name), description: e.description }));
    } catch {
      // Permission-scoped tokens commonly fail here. The picker still works
      // because the standard events list is always available.
      return [];
    }
  },
};

// Standard Meta CAPI events the picker shows regardless of what's registered
// against the dataset. Stable list — Meta has not added a new standard event
// since 2022.
export const META_STANDARD_EVENTS = [
  'Purchase',
  'Lead',
  'CompleteRegistration',
  'Subscribe',
  'StartTrial',
  'AddToCart',
  'AddPaymentInfo',
  'InitiateCheckout',
  'ViewContent',
  'Search',
  'Contact',
  'FindLocation',
  'Schedule',
  'SubmitApplication',
] as const;

// ── helpers ───────────────────────────────────────────────────────────

interface AdAccountRaw {
  id?: string;                  // 'act_<digits>'
  account_id?: string;          // just the digits
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number | string;
  business?: { id?: string; name?: string };
}

export interface AdAccountSummary {
  id: string;                   // 'act_<digits>' — what CAPI expects
  account_id: string;           // digits only
  name: string;
  currency_code: string;
  time_zone: string;
  account_status?: string;
  business_id?: string;
}

function normaliseAdAccount(raw: AdAccountRaw): AdAccountSummary {
  const id =
    typeof raw.id === 'string' && raw.id.startsWith('act_')
      ? raw.id
      : raw.account_id
      ? `act_${raw.account_id}`
      : '';
  const account_id =
    raw.account_id ??
    (typeof raw.id === 'string' && raw.id.startsWith('act_') ? raw.id.slice(4) : '');
  return {
    id,
    account_id,
    name: String(raw.name ?? ''),
    currency_code: String(raw.currency ?? ''),
    time_zone: String(raw.timezone_name ?? ''),
    account_status: raw.account_status != null ? String(raw.account_status) : undefined,
    business_id: raw.business?.id ? String(raw.business.id) : undefined,
  };
}

function dedupeAdAccountsById(list: AdAccountSummary[]): AdAccountSummary[] {
  const seen = new Map<string, AdAccountSummary>();
  for (const a of list) {
    const prev = seen.get(a.id);
    if (!prev || (!prev.name && a.name)) seen.set(a.id, a);
  }
  return Array.from(seen.values()).sort((x, y) =>
    (x.name || x.id).localeCompare(y.name || y.id)
  );
}

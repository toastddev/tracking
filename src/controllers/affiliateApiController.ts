import type { Context } from 'hono';
import { affiliateApiRepository, affiliateApiRunRepository } from '../firestore';
import { affiliateApiScheduler } from '../services/affiliateApiScheduler';
import { runAffiliateApi } from '../services/affiliateApiSyncService';
import { encryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import type {
  AffiliateApi,
  AffiliateApiAuthConfig,
  AffiliateApiIncremental,
  AffiliateApiKind,
  AffiliateApiMapping,
  AffiliateApiPagination,
  AffiliateApiRequestConfig,
  AffiliateApiResponseFormat,
  AffiliateApiSchedule,
  EncryptedBlob,
} from '../types';

const RESPONSE_FORMATS: AffiliateApiResponseFormat[] = ['json', 'xml', 'auto'];

function parseResponseFormat(v: unknown, fallback: AffiliateApiResponseFormat = 'auto'): AffiliateApiResponseFormat {
  return RESPONSE_FORMATS.includes(v as AffiliateApiResponseFormat)
    ? (v as AffiliateApiResponseFormat)
    : fallback;
}

const ID_RE = /^[a-z0-9][a-z0-9_\-]{1,63}$/;

function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function asMap(v: unknown): Record<string, string> | undefined {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

type ParsedAuth =
  | { ok: true; value: AffiliateApiAuthConfig }
  | { ok: false; error: string };

function parseAuth(raw: unknown, existing: AffiliateApiAuthConfig | undefined): ParsedAuth {
  if (raw == null || typeof raw !== 'object') return { ok: true, value: existing ?? { type: 'none' } };
  const a = raw as Record<string, unknown>;
  const type = a.type as AffiliateApiAuthConfig['type'];
  if (!['none', 'api_key', 'bearer', 'basic', 'custom'].includes(type)) {
    return { ok: false, error: 'invalid_auth_type' };
  }

  // Secret handling: client posts `value` (plaintext) only when changing it.
  // Otherwise we keep the existing encrypted blob.
  const value = typeof a.value === 'string' && a.value !== '' ? (a.value as string) : null;
  let value_enc: EncryptedBlob | undefined = existing?.value_enc;
  if (value !== null) {
    try { value_enc = encryptSecret(value); }
    catch (err) {
      logger.error('aff_api_auth_encrypt_failed', { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'encryption_unavailable' };
    }
  }
  // Wipe the secret if explicitly set to "" via a sentinel field.
  if (a.clear_secret === true) value_enc = undefined;

  const out: AffiliateApiAuthConfig = { type };
  if (type === 'api_key') {
    out.in = a.in === 'query' ? 'query' : 'header';
    out.key_name = asString(a.key_name) ?? 'X-API-Key';
    out.value_enc = value_enc;
  } else if (type === 'bearer') {
    out.value_enc = value_enc;
  } else if (type === 'basic') {
    out.username = asString(a.username);
    out.value_enc = value_enc;
  }
  return { ok: true, value: out };
}

function parsePagination(raw: unknown): AffiliateApiPagination {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = (p.type as AffiliateApiPagination['type']) ?? 'none';
  const allowed: AffiliateApiPagination['type'][] = ['none', 'page', 'offset', 'cursor'];
  return {
    type: allowed.includes(type) ? type : 'none',
    page_param: asString(p.page_param),
    start_page: typeof p.start_page === 'number' ? p.start_page : undefined,
    offset_param: asString(p.offset_param),
    cursor_param: asString(p.cursor_param),
    next_cursor_path: asString(p.next_cursor_path),
    size_param: asString(p.size_param),
    page_size: typeof p.page_size === 'number' ? p.page_size : undefined,
    max_pages: typeof p.max_pages === 'number' ? clampInt(p.max_pages, 1, 1000, 50) : undefined,
  };
}

function parseIncremental(raw: unknown): AffiliateApiIncremental {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: Boolean(p.enabled),
    from_param: asString(p.from_param),
    to_param: asString(p.to_param),
    format: (['iso', 'unix_ms', 'unix_s', 'date'] as const).includes(p.format as 'iso')
      ? (p.format as AffiliateApiIncremental['format'])
      : 'iso',
    lookback_minutes:
      typeof p.lookback_minutes === 'number' ? clampInt(p.lookback_minutes, 0, 7 * 24 * 60, 30) : 30,
  };
}

function parseMapping(raw: unknown): { ok: true; value: AffiliateApiMapping } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'mapping_required' };
  const m = raw as Record<string, unknown>;
  const items_path = asString(m.items_path);
  const external_id_path = asString(m.external_id_path);
  const click_id_path = asString(m.click_id_path);
  if (!items_path || !external_id_path || !click_id_path) {
    return { ok: false, error: 'mapping_required_fields' };
  }
  const status_map_raw = m.status_map;
  let status_map: Record<string, string> | undefined;
  if (status_map_raw && typeof status_map_raw === 'object' && !Array.isArray(status_map_raw)) {
    status_map = {};
    for (const [k, v] of Object.entries(status_map_raw as Record<string, unknown>)) {
      if (typeof v === 'string') status_map[k] = v;
    }
  }
  return {
    ok: true,
    value: {
      items_path,
      external_id_path,
      click_id_path,
      payout_path: asString(m.payout_path),
      currency_path: asString(m.currency_path),
      status_path: asString(m.status_path),
      txn_id_path: asString(m.txn_id_path),
      event_time_path: asString(m.event_time_path),
      status_map,
      default_status: asString(m.default_status),
    },
  };
}

function parseSchedule(raw: unknown): AffiliateApiSchedule {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const enabled = s.enabled !== false;
  // Allow 1..1440 runs/day. Common buttons: 1,2,4,6,12,24,48,96.
  const runs_per_day = clampInt(s.runs_per_day, 1, 1440, 4);
  return { enabled, runs_per_day };
}

function parseRequest(raw: unknown, kind: AffiliateApiKind): AffiliateApiRequestConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (kind === 'graphql') {
    const vars = (r.graphql_variables && typeof r.graphql_variables === 'object' && !Array.isArray(r.graphql_variables))
      ? (r.graphql_variables as Record<string, unknown>)
      : undefined;
    return {
      graphql_query: asString(r.graphql_query),
      graphql_variables: vars,
      headers: asMap(r.headers),
    };
  }
  return {
    http_method: r.http_method === 'POST' ? 'POST' : 'GET',
    query_params: asMap(r.query_params),
    body_template: asString(r.body_template),
    headers: asMap(r.headers),
  };
}

function publicView(api: AffiliateApi): Record<string, unknown> {
  // Strip the encrypted secret so the UI never receives the ciphertext.
  return {
    ...api,
    auth: {
      type: api.auth.type,
      in: api.auth.in,
      key_name: api.auth.key_name,
      username: api.auth.username,
      has_secret: !!api.auth.value_enc,
    },
    lock_holder: undefined,
    lock_until: undefined,
  };
}

export const affiliateApiController = {
  async list(c: Context) {
    const result = await affiliateApiRepository.list({
      q: c.req.query('q'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json({
      items: result.items.map(publicView),
      nextCursor: result.nextCursor,
    });
  },

  async get(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const api = await affiliateApiRepository.getById(id);
    if (!api) return c.json({ error: 'not_found' }, 404);
    return c.json(publicView(api));
  },

  async create(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const api_id = String(body.api_id ?? '').trim();
    const name = String(body.name ?? '').trim();
    const kind: AffiliateApiKind = body.kind === 'graphql' ? 'graphql' : 'rest';
    const base_url = String(body.base_url ?? '').trim();
    const status: 'active' | 'paused' = body.status === 'paused' ? 'paused' : 'active';

    if (!isValidId(api_id)) return c.json({ error: 'invalid_api_id' }, 400);
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!base_url) return c.json({ error: 'base_url_required' }, 400);
    try { new URL(base_url); } catch { return c.json({ error: 'invalid_base_url' }, 400); }

    const auth = parseAuth(body.auth, undefined);
    if (!auth.ok) return c.json({ error: auth.error }, 400);
    const mapping = parseMapping(body.mapping);
    if (!mapping.ok) return c.json({ error: mapping.error }, 400);

    const data = {
      name,
      status,
      kind,
      response_format: parseResponseFormat(body.response_format, 'auto'),
      base_url,
      network_id: asString(body.network_id),
      auth: auth.value,
      request: parseRequest(body.request, kind),
      pagination: parsePagination(body.pagination),
      incremental: parseIncremental(body.incremental),
      mapping: mapping.value,
      schedule: parseSchedule(body.schedule),
      timeout_ms: typeof body.timeout_ms === 'number'
        ? clampInt(body.timeout_ms, 1000, 5 * 60_000, 30_000)
        : 30_000,
      max_records_per_run: typeof body.max_records_per_run === 'number'
        ? clampInt(body.max_records_per_run, 100, 1_000_000, 50_000)
        : 50_000,
    };

    try {
      const api = await affiliateApiRepository.create(api_id, data);
      return c.json(publicView(api), 201);
    } catch (err) {
      if (err instanceof Error && err.message === 'affiliate_api_already_exists') {
        return c.json({ error: 'affiliate_api_already_exists' }, 409);
      }
      logger.error('aff_api_create_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async update(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const existing = await affiliateApiRepository.getById(id);
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: Partial<AffiliateApi> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (body.status === 'active' || body.status === 'paused') patch.status = body.status;
    if (body.kind === 'rest' || body.kind === 'graphql') patch.kind = body.kind;
    if ('response_format' in body) patch.response_format = parseResponseFormat(body.response_format, existing.response_format);
    if (typeof body.base_url === 'string' && body.base_url.trim()) {
      try { new URL(body.base_url.trim()); } catch { return c.json({ error: 'invalid_base_url' }, 400); }
      patch.base_url = body.base_url.trim();
    }
    if ('network_id' in body) patch.network_id = asString(body.network_id);
    if ('auth' in body) {
      const auth = parseAuth(body.auth, existing.auth);
      if (!auth.ok) return c.json({ error: auth.error }, 400);
      patch.auth = auth.value;
    }
    if ('request' in body) patch.request = parseRequest(body.request, (patch.kind ?? existing.kind));
    if ('pagination' in body) patch.pagination = parsePagination(body.pagination);
    if ('incremental' in body) patch.incremental = parseIncremental(body.incremental);
    if ('mapping' in body) {
      const mapping = parseMapping(body.mapping);
      if (!mapping.ok) return c.json({ error: mapping.error }, 400);
      patch.mapping = mapping.value;
    }
    if ('schedule' in body) patch.schedule = parseSchedule(body.schedule);
    if (typeof body.timeout_ms === 'number') patch.timeout_ms = clampInt(body.timeout_ms, 1000, 5 * 60_000, 30_000);
    if (typeof body.max_records_per_run === 'number') {
      patch.max_records_per_run = clampInt(body.max_records_per_run, 100, 1_000_000, 50_000);
    }

    const updated = await affiliateApiRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(publicView(updated));
  },

  async delete(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const ok = await affiliateApiRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  async runNow(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const result = await affiliateApiScheduler.runNow(id, { triggered_by: 'manual' });
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : result.reason === 'locked' ? 409 : 500;
      return c.json({ error: result.reason }, status);
    }
    return c.json({ ok: true, run_id: result.run_id });
  },

  async testRun(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const api = await affiliateApiRepository.getById(id);
    if (!api) return c.json({ error: 'not_found' }, 404);
    const run = await runAffiliateApi(api, { triggered_by: 'manual', dryRun: true });
    return c.json({ ok: true, run });
  },

  async runs(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 25;
    const items = await affiliateApiRunRepository.listByApi(id, limit);
    return c.json({ items });
  },
};

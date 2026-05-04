import { createHash } from 'node:crypto';
import { decryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { parseResponseBody } from '../utils/responseParser';
import {
  affiliateApiRepository,
  affiliateApiRunRepository,
  conversionRepository,
  clickRepository,
  offerReportRepository,
  drilldownRepository,
  campaignReportRepository,
} from '../firestore';
import { __campaignFromExtra as extractCampaign } from './clickService';
import { generateConversionId } from '../utils/idGenerator';
import { googleAdsForwardingService } from './googleAdsForwardingService';
import { eventDate } from './eventTime';
import type {
  AffiliateApi,
  AffiliateApiAuthConfig,
  AffiliateApiPagination,
  AffiliateApiRunRecord,
  ClickRecord,
  ConversionRecord,
} from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_RECORDS = 50_000;
const DEDUPE_BATCH = 250;

// Dedupe doc id: deterministic SHA-1 of (api_id, external_id). Same external
// id seen twice across runs collapses into a single conversion doc — the
// sync writes are idempotent without an upfront read.
function deterministicConversionId(api_id: string, external_id: string): string {
  const h = createHash('sha1').update(`${api_id}\x00${external_id}`).digest('hex');
  // UUID-ish: 8-4-4-4-12 layout for visual parity with our v7 ids elsewhere.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// dot/bracket path access. Supports "data.items[0].id", "edges.node.id".
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return obj ?? undefined;
  const parts = path.split('.').flatMap((seg) => {
    const m: string[] = [];
    let buf = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i]!;
      if (ch === '[') {
        if (buf) { m.push(buf); buf = ''; }
        const close = seg.indexOf(']', i);
        if (close < 0) return [seg];
        m.push(seg.slice(i + 1, close));
        i = close;
      } else {
        buf += ch;
      }
    }
    if (buf) m.push(buf);
    return m;
  });
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}
function asNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function formatTime(d: Date, fmt: 'iso' | 'unix_ms' | 'unix_s' | 'date' | undefined): string {
  switch (fmt) {
    case 'unix_ms': return String(d.getTime());
    case 'unix_s':  return String(Math.floor(d.getTime() / 1000));
    case 'date':    return d.toISOString().slice(0, 10);
    case 'iso':
    default:        return d.toISOString();
  }
}

function renderTemplate(input: string, vars: Record<string, string>): string {
  // Simple {{name}} substitution. Avoids pulling in a templating dep.
  return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

function applyAuth(
  auth: AffiliateApiAuthConfig,
  headers: Record<string, string>,
  query: URLSearchParams
): void {
  if (auth.type === 'none') return;
  const value = auth.value_enc ? decryptSecret(auth.value_enc) : '';
  if (auth.type === 'bearer') {
    headers['Authorization'] = `Bearer ${value}`;
    return;
  }
  if (auth.type === 'basic') {
    const userPart = auth.username ?? '';
    const enc = Buffer.from(`${userPart}:${value}`, 'utf8').toString('base64');
    headers['Authorization'] = `Basic ${enc}`;
    return;
  }
  if (auth.type === 'api_key') {
    const name = auth.key_name || 'X-API-Key';
    if (auth.in === 'query') query.set(name, value);
    else headers[name] = value;
    return;
  }
  // 'custom' uses request.headers map directly — no decryption.
}

interface FetchOnceResult {
  items: unknown[];
  nextCursor?: string;
  rawSize: number;
}

async function fetchOnce(opts: {
  api: AffiliateApi;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal?: AbortSignal;
}): Promise<FetchOnceResult> {
  const { api, url, headers, body, signal } = opts;
  const method = api.kind === 'graphql' ? 'POST' : (api.request.http_method ?? 'GET');
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`http_${res.status}: ${errBody.slice(0, 200)}`);
  }

  // undici (Node fetch) auto-decompresses gzip / deflate / brotli when the
  // upstream sets Content-Encoding correctly, which covers Kelkoo, Admedia,
  // and every other spec-compliant API.
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  const data = parseResponseBody({
    body: text,
    contentType: ct,
    format: api.kind === 'graphql' ? 'json' : (api.response_format ?? 'auto'),
    itemsPath: api.mapping.items_path,
  });

  const itemsRaw = getPath(data, api.mapping.items_path);
  const items = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw != null ? [itemsRaw] : [];
  const nextCursor =
    api.pagination.type === 'cursor' && api.pagination.next_cursor_path
      ? asString(getPath(data, api.pagination.next_cursor_path))
      : undefined;
  return { items, nextCursor, rawSize: items.length };
}

function buildUrlAndBody(
  api: AffiliateApi,
  windowVars: Record<string, string>,
  pageVars: Record<string, string | number>
): { url: string; body: string | undefined } {
  const url = new URL(api.base_url);
  const headers: Record<string, string> = {};
  applyAuth(api.auth, headers, url.searchParams);

  // Static query params (rendered).
  for (const [k, v] of Object.entries(api.request.query_params ?? {})) {
    url.searchParams.set(k, renderTemplate(v, windowVars));
  }
  // Pagination + incremental query injection (REST only).
  if (api.kind === 'rest') {
    const pg = api.pagination;
    if (pg.type === 'page') {
      url.searchParams.set(pg.page_param ?? 'page', String(pageVars.page ?? 1));
      if (pg.page_size != null) url.searchParams.set(pg.size_param ?? 'limit', String(pg.page_size));
    } else if (pg.type === 'offset') {
      url.searchParams.set(pg.offset_param ?? 'offset', String(pageVars.offset ?? 0));
      if (pg.page_size != null) url.searchParams.set(pg.size_param ?? 'limit', String(pg.page_size));
    } else if (pg.type === 'cursor' && pageVars.cursor != null && pageVars.cursor !== '') {
      url.searchParams.set(pg.cursor_param ?? 'cursor', String(pageVars.cursor));
    }
    const inc = api.incremental;
    if (inc.enabled) {
      if (inc.from_param && windowVars.from) url.searchParams.set(inc.from_param, windowVars.from);
      if (inc.to_param && windowVars.to) url.searchParams.set(inc.to_param, windowVars.to);
    }
  }

  // Body
  let body: string | undefined;
  if (api.kind === 'graphql') {
    const variables = {
      ...(api.request.graphql_variables ?? {}),
      ...windowVars,
      ...pageVars,
    };
    body = JSON.stringify({ query: api.request.graphql_query ?? '', variables });
  } else if (api.request.body_template) {
    body = renderTemplate(api.request.body_template, {
      ...windowVars,
      ...Object.fromEntries(Object.entries(pageVars).map(([k, v]) => [k, String(v)])),
    });
  }
  return { url: url.toString(), body };
}

function buildHeaders(api: AffiliateApi): Record<string, string> {
  // GraphQL is always JSON. For REST, advertise what we can parse — server
  // is free to ignore Accept, but most respect it. 'auto' accepts both.
  const accept =
    api.kind === 'graphql' || api.response_format === 'json' || api.response_format === undefined
      ? 'application/json'
      : api.response_format === 'xml'
        ? 'application/xml, text/xml;q=0.9'
        : 'application/json, application/xml;q=0.9, text/xml;q=0.8';
  const headers: Record<string, string> = { Accept: accept };
  if (api.kind === 'graphql' || api.request.body_template) {
    headers['Content-Type'] = 'application/json';
  }
  for (const [k, v] of Object.entries(api.request.headers ?? {})) {
    headers[k] = v;
  }
  // applyAuth runs separately (it shares the URLSearchParams instance) — we
  // re-apply here so the headers map gets populated for the actual request.
  const sink = new URLSearchParams();
  applyAuth(api.auth, headers, sink);
  return headers;
}

// Map one upstream item → ConversionRecord candidate. Returns null when a
// required field is missing — counted as failed in the run summary.
function mapItem(api: AffiliateApi, item: unknown): {
  external_id: string;
  click_id: string;
  payout?: number;
  currency?: string;
  status?: string;
  txn_id?: string;
  network_timestamp?: string;
} | null {
  const m = api.mapping;
  const external_id = asString(getPath(item, m.external_id_path));
  const click_id = asString(getPath(item, m.click_id_path));
  if (!external_id || !click_id) return null;

  const rawStatus = m.status_path ? asString(getPath(item, m.status_path)) : undefined;
  const mappedStatus = rawStatus && m.status_map ? m.status_map[rawStatus] ?? rawStatus : rawStatus;

  return {
    external_id,
    click_id,
    payout: m.payout_path ? asNumber(getPath(item, m.payout_path)) : undefined,
    currency: m.currency_path ? asString(getPath(item, m.currency_path)) : undefined,
    status: mappedStatus ?? m.default_status,
    txn_id: m.txn_id_path ? asString(getPath(item, m.txn_id_path)) : undefined,
    network_timestamp: m.event_time_path ? asString(getPath(item, m.event_time_path)) : undefined,
  };
}

export interface RunOptions {
  triggered_by: 'schedule' | 'manual';
  // Cloud Run instance tag (hostname#pid). Stored in the run doc so boot
  // cleanup can be scoped to only this instance's orphans.
  holder?: string;
  windowFrom?: Date;
  windowTo?: Date;
  // Don't actually persist — used by the "test" endpoint to dry-run mappings.
  dryRun?: boolean;
}

export async function runAffiliateApi(api: AffiliateApi, opts: RunOptions): Promise<AffiliateApiRunRecord> {
  const run_id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const started = new Date();
  const incremental = api.incremental;
  const lookback = (incremental.lookback_minutes ?? 30) * 60_000;
  const lastRun = api.schedule.last_run_at ? new Date(api.schedule.last_run_at) : null;
  const windowFrom =
    opts.windowFrom ??
    (incremental.enabled
      ? new Date((lastRun ? lastRun.getTime() : Date.now() - 24 * 60 * 60_000) - lookback)
      : new Date(Date.now() - 24 * 60 * 60_000));
  const windowTo = opts.windowTo ?? started;
  const fmt = incremental.format ?? 'iso';
  const windowVars: Record<string, string> = {
    from: formatTime(windowFrom, fmt),
    to: formatTime(windowTo, fmt),
  };

  const run: AffiliateApiRunRecord = {
    run_id,
    api_id: api.api_id,
    holder: opts.holder,
    status: 'running',
    started_at: started.toISOString(),
    pages_fetched: 0,
    records_seen: 0,
    records_inserted: 0,
    records_skipped_duplicate: 0,
    records_skipped_unknown_click: 0,
    records_failed: 0,
    http_calls: 0,
    window_from: windowFrom.toISOString(),
    window_to: windowTo.toISOString(),
    triggered_by: opts.triggered_by,
  };

  if (!opts.dryRun) {
    await affiliateApiRunRepository.insert(run).catch((err) => {
      logger.warn('aff_api_run_insert_failed', { api_id: api.api_id, error: String(err) });
    });
  }

  const headers = buildHeaders(api);
  const timeoutMs = api.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxPages = api.pagination.max_pages ?? DEFAULT_MAX_PAGES;
  const maxRecords = api.max_records_per_run ?? DEFAULT_MAX_RECORDS;
  const pg: AffiliateApiPagination = api.pagination;

  const seenExternalIds = new Set<string>();
  // Buffer carries the click alongside the conversion so flush() can hand
  // it directly to the forwarder without a second Firestore read. Halves
  // per-item read cost vs. looking the click up twice.
  const buffer: Array<{ conv: ConversionRecord; click: ClickRecord }> = [];
  // Accumulate Google Ads batch upload stats across all flush() calls.
  const gadsStats = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    if (opts.dryRun) { buffer.length = 0; return; }
    const batch = buffer.splice(0, buffer.length);
    try {
      const convs = batch.map((b) => b.conv);
      const { inserted, duplicates } = await conversionRepository.bulkInsertIfAbsent(convs);
      run.records_inserted = (run.records_inserted ?? 0) + inserted;
      run.records_skipped_duplicate = (run.records_skipped_duplicate ?? 0) + duplicates;

      // Roll-up into offer_reports. We can't easily separate which rows in
      // the batch were duplicates vs new (BulkWriter resolves async), so we
      // increment based on the full batch — for an idempotent re-run of the
      // same window this would double-count. Mitigate by only rolling up
      // when the inserted/duplicates ratio shows mostly fresh inserts:
      // duplicate-heavy batches are skipped to avoid corrupting the rollup.
      if (inserted > 0 && inserted >= duplicates) {
        const rollupRows = batch
          .filter((b) => b.conv.offer_id && b.conv.verified)
          .map((b) => ({
            offer_id: b.conv.offer_id as string,
            network_id: b.conv.network_id,
            // Bucket on event-time (network_timestamp), not receipt-time —
            // this is the path that smears late pulls across days.
            at: eventDate(b.conv),
            verified: true,
            status: b.conv.status,
            payout: b.conv.payout,
          }));
        offerReportRepository.incrementConversionsBulk(rollupRows).catch((err: unknown) => {
          logger.warn('offer_report_aff_api_rollup_failed', {
            api_id: api.api_id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        // Same pattern for campaign_reports — derive campaign_id from each
        // conversion's click extra_params. Rows without a campaign tag are
        // dropped silently (they don't belong to any campaign).
        const campaignRollupRows = batch
          .filter((b) => b.conv.offer_id && b.conv.verified)
          .map((b) => {
            const c = extractCampaign(b.click.extra_params);
            if (!c) return null;
            return {
              campaign_id: c.campaign_id,
              source: c.source,
              at: eventDate(b.conv),
              verified: true,
              status: b.conv.status,
              payout: b.conv.payout,
              offer_id: b.conv.offer_id as string,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (campaignRollupRows.length > 0) {
          campaignReportRepository.incrementConversionsBulk(campaignRollupRows).catch((err: unknown) => {
            logger.warn('campaign_report_aff_api_rollup_failed', {
              api_id: api.api_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        for (const { conv, click } of batch) {
          drilldownRepository.incrementOfferConversion(conv, click).catch((err: unknown) => {
            logger.warn('drilldown_offer_conversion_aff_api_failed', {
              api_id: api.api_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          drilldownRepository.incrementPostback(conv).catch((err: unknown) => {
            logger.warn('drilldown_postback_aff_api_failed', {
              api_id: api.api_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }

      // Hand rows to Google Ads forwarder in a single batch call per
      // connection — dramatically reduces API calls vs one-by-one.
      const verifiedBatch = batch.filter((b) => b.conv.verified);
      if (verifiedBatch.length > 0) {
        try {
          const gadsResult = await googleAdsForwardingService.dispatchConversionsBatch(
            verifiedBatch.map((b) => ({ conversion: b.conv, click: b.click }))
          );
          gadsStats.sent += gadsResult.sent;
          gadsStats.skipped += gadsResult.skipped;
          gadsStats.failed += gadsResult.failed;
          gadsStats.errors.push(...gadsResult.errors);
        } catch (err) {
          gadsStats.failed += verifiedBatch.length;
          gadsStats.errors.push(err instanceof Error ? err.message : String(err));
          logger.warn('gads_batch_dispatch_failed', {
            api_id: api.api_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      run.records_failed = (run.records_failed ?? 0) + batch.length;
      logger.error('aff_api_bulk_insert_failed', {
        api_id: api.api_id,
        run_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let cursor: string | undefined;
  let page = pg.start_page ?? 1;
  let offset = 0;

  try {
    for (let i = 0; i < maxPages; i++) {
      const pageVars: Record<string, string | number> = { page, offset, cursor: cursor ?? '' };
      const { url, body } = buildUrlAndBody(api, windowVars, pageVars);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let result: FetchOnceResult;
      try {
        result = await fetchOnce({ api, url, headers, body, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      run.http_calls = (run.http_calls ?? 0) + 1;
      run.pages_fetched = (run.pages_fetched ?? 0) + 1;

      for (const item of result.items) {
        const mapped = mapItem(api, item);
        if (!mapped) {
          run.records_failed = (run.records_failed ?? 0) + 1;
          continue;
        }
        run.records_seen = (run.records_seen ?? 0) + 1;

        // In-run dedupe — same external_id from two pages doesn't double-write.
        if (seenExternalIds.has(mapped.external_id)) continue;
        seenExternalIds.add(mapped.external_id);

        const conversion_id = deterministicConversionId(api.api_id, mapped.external_id);

        // Click verification. Skip the row entirely if we don't recognise the
        // click — keeps reports clean. Counted separately for visibility.
        // The repository's getById is cached so repeat lookups within a run
        // (same click hit twice) are free.
        const click = await clickRepository.getById(mapped.click_id);
        if (!click) {
          run.records_skipped_unknown_click = (run.records_skipped_unknown_click ?? 0) + 1;
          continue;
        }

        const conv: ConversionRecord = {
          conversion_id,
          network_id: api.network_id ?? api.api_id,
          click_id: mapped.click_id,
          offer_id: click.offer_id,
          payout: mapped.payout,
          currency: mapped.currency,
          status: mapped.status ?? api.mapping.default_status ?? 'approved',
          txn_id: mapped.txn_id,
          network_timestamp: mapped.network_timestamp,
          raw_payload: item as Record<string, unknown>,
          method: 'GET',
          verified: true,
          verification_reason: 'click_found',
          source: 'api',
          shadow: false,
          aff_api_id: api.api_id,
          external_id: mapped.external_id,
          created_at: new Date().toISOString(),
        };
        buffer.push({ conv, click });
        if (buffer.length >= DEDUPE_BATCH) await flush();
        if ((run.records_seen ?? 0) >= maxRecords) {
          await flush();
          run.status = 'partial';
          run.error = 'max_records_per_run_reached';
          break;
        }
      }

      // Pagination advance / termination.
      if (result.items.length === 0) break;
      if ((run.records_seen ?? 0) >= maxRecords) break;
      if (pg.type === 'none') break;
      if (pg.type === 'page') {
        page += 1;
        if (pg.page_size && result.items.length < pg.page_size) break;
      } else if (pg.type === 'offset') {
        offset += result.items.length;
        if (pg.page_size && result.items.length < pg.page_size) break;
      } else if (pg.type === 'cursor') {
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }

    await flush();
    if (run.status === 'running') {
      if ((run.records_failed ?? 0) > 0) {
        run.status = 'partial';
      } else if (gadsStats.failed > 0 && gadsStats.sent === 0) {
        // Data fetched and persisted OK, but every Google Ads upload failed.
        run.status = 'gads_upload_error';
        run.error = 'Google Ads upload failed for all conversions';
      } else {
        run.status = 'ok';
      }
    }
  } catch (err) {
    run.status = 'error';
    run.error = err instanceof Error ? err.message : String(err);
    logger.error('aff_api_run_failed', {
      api_id: api.api_id,
      run_id,
      error: run.error,
    });
  }

  const finished = new Date();
  run.finished_at = finished.toISOString();
  run.duration_ms = finished.getTime() - started.getTime();

  if (!opts.dryRun) {
    await affiliateApiRunRepository.update(run_id, {
      status: run.status,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      pages_fetched: run.pages_fetched,
      records_seen: run.records_seen,
      records_inserted: run.records_inserted,
      records_skipped_duplicate: run.records_skipped_duplicate,
      records_skipped_unknown_click: run.records_skipped_unknown_click,
      records_failed: run.records_failed,
      http_calls: run.http_calls,
      error: run.error,
      gads_sent: gadsStats.sent,
      gads_skipped: gadsStats.skipped,
      gads_failed: gadsStats.failed,
      gads_errors: gadsStats.errors.length > 0 ? gadsStats.errors.slice(0, 10) : undefined,
    }).catch((err) => {
      logger.warn('aff_api_run_update_failed', { api_id: api.api_id, run_id, error: String(err) });
    });

    // Schedule next run by runs_per_day cadence.
    const intervalMs = Math.max(60_000, Math.floor((24 * 60 * 60_000) / Math.max(1, api.schedule.runs_per_day)));
    const nextRun = new Date(finished.getTime() + intervalMs);
    const outcome: 'ok' | 'partial' | 'error' =
      run.status === 'ok' ? 'ok'
        : run.status === 'error' ? 'error'
        : 'partial';   // covers 'partial', 'gads_upload_error', and any future sub-statuses
    await affiliateApiRepository.recordRunOutcome(api.api_id, nextRun, finished, outcome).catch((err) => {
      logger.warn('aff_api_record_outcome_failed', { api_id: api.api_id, error: String(err) });
    });
  }

  return run;
}

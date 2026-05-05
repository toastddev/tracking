import type { Context } from 'hono';
import {
  buildRouteId,
  clickRepository,
  conversionRepository,
  googleAdsConnectionRepository,
  googleAdsMccChildrenRepository,
  googleAdsRouteRepository,
  googleAdsUploadRepository,
  networkRepository,
  offerRepository,
} from '../firestore';
import { generateConversionId } from '../utils/idGenerator';
import { encryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { googleAdsOauthService } from '../services/googleAdsOauthService';
import { googleAdsAccountService } from '../services/googleAdsAccountService';
import { googleAdsForwardingService } from '../services/googleAdsForwardingService';
import { signGrantToken, verifyGrantToken } from '../utils/googleAdsState';
import type {
  GoogleAdsCandidate,
  GoogleAdsConnection,
  GoogleAdsConnectionPublic,
  GoogleAdsConnectionType,
  GoogleAdsRouteScope,
} from '../types/googleAds';

function getAdminEmail(c: Context): string {
  return (c.get('admin_email' as never) as string | undefined) ?? '';
}

function publicConnection(conn: GoogleAdsConnection): GoogleAdsConnectionPublic {
  return {
    connection_id: conn.connection_id,
    type: conn.type,
    google_user_email: conn.google_user_email,
    customer_id: conn.customer_id,
    manager_customer_id: conn.manager_customer_id,
    descriptive_name: conn.descriptive_name,
    currency_code: conn.currency_code,
    time_zone: conn.time_zone,
    sale_conversion_action_resource: conn.sale_conversion_action_resource,
    sale_conversion_action_name: conn.sale_conversion_action_name,
    click_conversion_action_resource: conn.click_conversion_action_resource,
    click_conversion_action_name: conn.click_conversion_action_name,
    status: conn.status,
    last_error: conn.last_error,
    created_at: conn.created_at,
    updated_at: conn.updated_at,
  };
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_\-]{1,63}$/.test(id);
}

function isValidCustomerId(cid: string): boolean {
  return /^\d{6,12}$/.test(cid);
}

function looksLikeConversionAction(s: string): boolean {
  return /^customers\/\d+\/conversionActions\/\d+$/.test(s);
}

export const googleAdsController = {
  // ── OAuth ─────────────────────────────────────────────────────────
  async oauthStart(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { type?: string };
    const type: GoogleAdsConnectionType | null =
      body.type === 'mcc' ? 'mcc' : body.type === 'child' ? 'child' : null;
    if (!type) return c.json({ error: 'invalid_type' }, 400);
    try {
      const result = await googleAdsOauthService.buildAuthUrl({
        admin_email: getAdminEmail(c),
        type,
      });
      logger.info('gads_oauth_started', { type, admin_email: getAdminEmail(c) });
      return c.json(result);
    } catch (err) {
      logger.error('gads_oauth_start_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'oauth_misconfigured' }, 500);
    }
  },

  // Step 1 of finalize: redeem the OAuth code and discover the candidate
  // accounts (MCCs, children) that the user could connect. Returns a stateless
  // grant_token containing the encrypted refresh token. Nothing is persisted
  // here — we wait for the user to pick.
  async oauthExchange(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { code?: string; state?: string };
    if (!body.code || !body.state) return c.json({ error: 'missing_code_or_state' }, 400);

    const adminEmail = getAdminEmail(c);
    const state = await googleAdsOauthService.verifyState(body.state, adminEmail);
    if (!state) return c.json({ error: 'invalid_state' }, 400);

    let exchanged;
    try {
      exchanged = await googleAdsOauthService.exchangeCode(body.code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('gads_oauth_exchange_failed', { error: msg });
      return c.json({ error: 'oauth_exchange_failed', message: msg }, 400);
    }

    const refresh_token_enc = encryptSecret(exchanged.refresh_token);

    // Discover candidates so the UI can let the user pick.
    let accessible: string[];
    try {
      accessible = await googleAdsAccountService.listAccessibleFromGrant(refresh_token_enc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('gads_list_accessible_failed', { error: msg });
      return c.json({ error: 'list_accessible_failed', message: msg }, 502);
    }
    if (accessible.length === 0) return c.json({ error: 'no_accessible_customers' }, 400);

    // Walk each accessible CID. For accounts that ARE managers (most common
    // when the user authenticated via an MCC), we pull their children too —
    // the picker shows everything.
    const candidates: GoogleAdsCandidate[] = [];
    const candidateIds = new Set<string>();
    for (const root of accessible) {
      let meta;
      try {
        meta = await googleAdsAccountService.fetchCustomerMetadata({
          refresh_token_enc,
          customer_id: root,
        });
      } catch {
        meta = { descriptive_name: '', currency_code: '', time_zone: '', is_manager: false };
      }
      if (!candidateIds.has(root)) {
        candidates.push({
          customer_id: root,
          descriptive_name: meta.descriptive_name,
          currency_code: meta.currency_code,
          time_zone: meta.time_zone,
          is_manager: meta.is_manager,
          level: 0,
        });
        candidateIds.add(root);
      }
      if (meta.is_manager) {
        try {
          const tree = await googleAdsAccountService.discoverHierarchy({
            refresh_token_enc,
            rootCustomerId: root,
          });
          for (const child of tree) {
            if (candidateIds.has(child.customer_id)) continue;
            candidates.push({ ...child, manager_customer_id: root });
            candidateIds.add(child.customer_id);
          }
        } catch {
          // Manager but hierarchy walk failed (e.g. permission scoped down).
          // The MCC itself remains a valid candidate.
        }
      }
    }

    const grant_token = await signGrantToken({
      refresh_token_enc,
      google_user_email: exchanged.google_user_email,
      scopes: exchanged.scopes,
      type: state.type,
    });

    return c.json({
      grant_token,
      type: state.type,
      google_user_email: exchanged.google_user_email,
      candidates,
    });
  },

  // Step 2 of finalize: user has picked which accounts to connect. Creates
  // one connection per pick. For MCC, we additionally snapshot the discovered
  // children for display.
  async finalize(c: Context) {
    const body = await c.req.json().catch(() => ({})) as {
      grant_token?: string;
      picks?: Array<{
        customer_id?: string;
        manager_customer_id?: string;
        descriptive_name?: string;
        currency_code?: string;
        time_zone?: string;
        is_manager?: boolean;
      }>;
      mcc_children?: Array<{
        customer_id?: string;
        descriptive_name?: string;
        currency_code?: string;
        time_zone?: string;
      }>;
    };
    if (!body.grant_token) return c.json({ error: 'missing_grant_token' }, 400);
    const grant = await verifyGrantToken(body.grant_token);
    if (!grant) return c.json({ error: 'invalid_grant_token' }, 400);

    const picks = Array.isArray(body.picks) ? body.picks : [];
    if (picks.length === 0) return c.json({ error: 'no_picks' }, 400);

    const out: GoogleAdsConnection[] = [];

    for (const p of picks) {
      const customer_id = String(p.customer_id ?? '').replace(/-/g, '');
      if (!isValidCustomerId(customer_id)) continue;

      // For child connections accessed through an MCC, the manager_customer_id
      // doubles as the login-customer-id header. For an MCC connection,
      // manager_customer_id is just the same CID (or undefined — call works
      // either way) so we leave it undefined to keep things simple.
      const manager_customer_id = grant.type === 'child'
        ? (p.manager_customer_id?.replace(/-/g, '') || undefined)
        : undefined;

      const connection_id = generateConversionId();
      const conn = await googleAdsConnectionRepository.insert({
        connection_id,
        type: grant.type,
        google_user_email: grant.google_user_email,
        refresh_token_enc: grant.refresh_token_enc,
        customer_id,
        manager_customer_id,
        descriptive_name: p.descriptive_name ?? '',
        currency_code: p.currency_code ?? '',
        time_zone: p.time_zone ?? '',
        scopes: grant.scopes,
        status: 'active',
      });
      out.push(conn);
      logger.info('gads_connection_created', {
        connection_id,
        type: grant.type,
        customer_id,
      });

      // For MCC: also persist the discovered child snapshot for display.
      if (grant.type === 'mcc' && Array.isArray(body.mcc_children)) {
        const mccChildren = body.mcc_children
          .map((c) => ({
            customer_id: String(c.customer_id ?? '').replace(/-/g, ''),
            descriptive_name: c.descriptive_name ?? '',
            currency_code: c.currency_code ?? '',
            time_zone: c.time_zone ?? '',
          }))
          .filter((c) => isValidCustomerId(c.customer_id) && c.customer_id !== customer_id);
        if (mccChildren.length > 0) {
          await googleAdsMccChildrenRepository.upsertMany(connection_id, mccChildren);
        }
      }
    }

    if (out.length === 0) return c.json({ error: 'no_valid_picks' }, 400);
    return c.json({ items: out.map(publicConnection) }, 201);
  },

  // ── Connections ────────────────────────────────────────────────────
  async listConnections(c: Context) {
    const items = await googleAdsConnectionRepository.list();
    return c.json({ items: items.map(publicConnection) });
  },

  async getConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await googleAdsConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    let mcc_children = undefined;
    if (conn.type === 'mcc') {
      mcc_children = await googleAdsMccChildrenRepository.listByConnection(id);
    }
    return c.json({ connection: publicConnection(conn), mcc_children });
  },

  async deleteConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    await googleAdsMccChildrenRepository.deleteByConnection(id);
    const ok = await googleAdsConnectionRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  async refreshMccChildren(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await googleAdsConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    if (conn.type !== 'mcc') return c.json({ error: 'not_mcc' }, 400);

    let tree: GoogleAdsCandidate[];
    try {
      tree = await googleAdsAccountService.discoverHierarchy({
        refresh_token_enc: conn.refresh_token_enc,
        rootCustomerId: conn.customer_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'discover_failed', message: msg }, 502);
    }

    const mccChildren = tree
      .filter((cand) => !cand.is_manager)
      .map((cand) => ({
        customer_id: cand.customer_id,
        descriptive_name: cand.descriptive_name ?? '',
        currency_code: cand.currency_code ?? '',
        time_zone: cand.time_zone ?? '',
      }));

    if (mccChildren.length > 0) {
      await googleAdsMccChildrenRepository.upsertMany(conn.connection_id, mccChildren);
    }

    return c.json({ mcc_children: mccChildren });
  },

  // Patch the conversion-action mappings on a connection. For MCC this is the
  // cross-account default; for a child it's used unless a per-offer route
  // overrides.
  async patchConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const body = await c.req.json().catch(() => ({})) as {
      sale_conversion_action_resource?: string | null;
      sale_conversion_action_name?: string | null;
      click_conversion_action_resource?: string | null;
      click_conversion_action_name?: string | null;
    };
    const patch: Parameters<typeof googleAdsConnectionRepository.update>[1] = {};
    if (body.sale_conversion_action_resource !== undefined) {
      const v = body.sale_conversion_action_resource;
      if (v && !looksLikeConversionAction(v)) return c.json({ error: 'invalid_sale_action' }, 400);
      patch.sale_conversion_action_resource = v ?? undefined;
    }
    if (body.sale_conversion_action_name !== undefined) {
      patch.sale_conversion_action_name = body.sale_conversion_action_name ?? undefined;
    }
    if (body.click_conversion_action_resource !== undefined) {
      const v = body.click_conversion_action_resource;
      if (v && !looksLikeConversionAction(v)) return c.json({ error: 'invalid_click_action' }, 400);
      patch.click_conversion_action_resource = v ?? undefined;
    }
    if (body.click_conversion_action_name !== undefined) {
      patch.click_conversion_action_name = body.click_conversion_action_name ?? undefined;
    }
    const updated = await googleAdsConnectionRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    logger.info('gads_connection_actions_set', {
      connection_id: id,
      sale: updated.sale_conversion_action_resource,
      click: updated.click_conversion_action_resource,
    });
    return c.json(publicConnection(updated));
  },

  async listConversionActions(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await googleAdsConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    try {
      const actions = await googleAdsAccountService.listConversionActions({
        connection: conn,
        forceRefresh: c.req.query('refresh') === 'true',
      });
      return c.json({ items: actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 502);
    }
  },

  // ── Routes ────────────────────────────────────────────────────────
  async upsertRoute(c: Context) {
    const body = await c.req.json().catch(() => ({})) as {
      scope_type?: string;
      scope_id?: string;
      target_connection_id?: string;
      sale_conversion_action_resource?: string;
      sale_conversion_action_name?: string;
      click_conversion_action_resource?: string;
      click_conversion_action_name?: string;
      enabled?: boolean;
    };
    const scope_type: GoogleAdsRouteScope | null =
      body.scope_type === 'offer' ? 'offer' :
      body.scope_type === 'network' ? 'network' :
      null;
    if (!scope_type) return c.json({ error: 'invalid_scope_type' }, 400);
    const scope_id = String(body.scope_id ?? '').trim();
    if (!isValidId(scope_id)) return c.json({ error: 'invalid_scope_id' }, 400);

    if (scope_type === 'offer') {
      const offer = await offerRepository.getById(scope_id);
      if (!offer) return c.json({ error: 'offer_not_found' }, 404);
    } else {
      const network = await networkRepository.getById(scope_id);
      if (!network) return c.json({ error: 'network_not_found' }, 404);
    }

    const target_connection_id = String(body.target_connection_id ?? '').trim();
    if (!target_connection_id) return c.json({ error: 'invalid_target_connection_id' }, 400);
    const target = await googleAdsConnectionRepository.getById(target_connection_id);
    if (!target) return c.json({ error: 'connection_not_found' }, 404);
    if (target.type !== 'child') return c.json({ error: 'route_target_must_be_child' }, 400);

    const sale = body.sale_conversion_action_resource?.trim();
    const click = body.click_conversion_action_resource?.trim();
    if (sale && !looksLikeConversionAction(sale)) return c.json({ error: 'invalid_sale_action' }, 400);
    if (click && !looksLikeConversionAction(click)) return c.json({ error: 'invalid_click_action' }, 400);
    if (!sale && !click) return c.json({ error: 'sale_or_click_required' }, 400);

    const enabled = body.enabled !== false;

    const route = await googleAdsRouteRepository.upsert({
      route_id: buildRouteId(scope_type, scope_id),
      scope_type,
      scope_id,
      target_connection_id,
      sale_conversion_action_resource: sale || undefined,
      sale_conversion_action_name: sale ? (body.sale_conversion_action_name?.trim() || '') : undefined,
      click_conversion_action_resource: click || undefined,
      click_conversion_action_name: click ? (body.click_conversion_action_name?.trim() || '') : undefined,
      enabled,
    });
    logger.info('gads_route_set', {
      route_id: route.route_id,
      target_connection_id,
      sale: !!sale,
      click: !!click,
    });
    return c.json(route);
  },

  async getRoute(c: Context) {
    const scope_type = c.req.query('scope_type');
    const scope_id = c.req.query('scope_id');
    if ((scope_type !== 'offer' && scope_type !== 'network') || !scope_id) {
      return c.json({ error: 'invalid_scope' }, 400);
    }
    const route = await googleAdsRouteRepository.getById(buildRouteId(scope_type, scope_id));
    if (!route) return c.json({ route: null });
    return c.json({ route });
  },

  async listRoutes(c: Context) {
    void c;
    const items = await googleAdsRouteRepository.listAll();
    return c.json({ items });
  },

  async deleteRoute(c: Context) {
    const id = c.req.param('route_id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const ok = await googleAdsRouteRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  // ── Uploads ───────────────────────────────────────────────────────
  async listUploadsForSource(c: Context) {
    const source_id = c.req.query('source_id');
    if (!source_id) return c.json({ error: 'invalid_source_id' }, 400);
    const items = await googleAdsUploadRepository.listForSource(source_id);
    return c.json({ items });
  },

  async retryUpload(c: Context) {
    const conversion_id = c.req.param('conversion_id');
    if (!conversion_id) return c.json({ error: 'invalid_id' }, 400);
    const conv = await conversionRepository.getById(conversion_id);
    if (!conv) return c.json({ error: 'conversion_not_found' }, 404);
    const click = conv.click_id ? await clickRepository.getById(conv.click_id) : null;
    await googleAdsForwardingService.dispatchConversion({ conversion: conv, click });
    return c.json({ ok: true });
  },
};

import {
  googleAdsApi,
  listAccessibleResourceNames,
  customerIdFromResourceName,
} from './googleAdsClient';
import { decryptSecret } from '../utils/crypto';
import type { EncryptedBlob } from '../utils/crypto';
import type {
  GoogleAdsCandidate,
  GoogleAdsConnection,
  GoogleAdsConversionAction,
} from '../types/googleAds';

const CONVERSION_ACTION_TTL_MS = 5 * 60 * 1000;
const conversionActionCache = new Map<string, { actions: GoogleAdsConversionAction[]; expires: number }>();

interface ClientLikeRow {
  customer_client?: {
    client_customer?: string;
    level?: number | string | { toString(): string };
    manager?: boolean;
    descriptive_name?: string;
    currency_code?: string;
    time_zone?: string;
    id?: string | number | { toString(): string };
  };
}

interface CustomerSelfRow {
  customer?: {
    id?: string | number | { toString(): string };
    descriptive_name?: string;
    currency_code?: string;
    time_zone?: string;
    manager?: boolean;
  };
}

function rowToCandidate(row: ClientLikeRow, parentManagerId: string): GoogleAdsCandidate | null {
  const cc = row.customer_client;
  if (!cc?.client_customer) return null;
  const id = customerIdFromResourceName(cc.client_customer);
  if (!id) return null;
  return {
    customer_id: id,
    manager_customer_id: parentManagerId,
    descriptive_name: cc.descriptive_name ?? '',
    currency_code: cc.currency_code ?? '',
    time_zone: cc.time_zone ?? '',
    is_manager: Boolean(cc.manager),
    level: typeof cc.level === 'number' ? cc.level : Number(cc.level ?? 0) || 0,
  };
}

// Fetch the seed customer's own metadata (so we can store name/currency/tz on
// the connection record without making the user fill it in).
async function fetchCustomerMetadata(args: {
  refresh_token_enc: EncryptedBlob;
  customer_id: string;
  login_customer_id?: string;
}): Promise<Pick<GoogleAdsCandidate, 'descriptive_name' | 'currency_code' | 'time_zone' | 'is_manager'>> {
  const refresh_token = decryptSecret(args.refresh_token_enc);
  const customer = googleAdsApi().Customer({
    customer_id: args.customer_id,
    refresh_token,
    login_customer_id: args.login_customer_id,
  });
  try {
    const rows = (await customer.query(
      `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager
       FROM customer
       LIMIT 1`
    )) as unknown as CustomerSelfRow[];
    const c = rows[0]?.customer;
    return {
      descriptive_name: c?.descriptive_name ?? '',
      currency_code: c?.currency_code ?? '',
      time_zone: c?.time_zone ?? '',
      is_manager: Boolean(c?.manager),
    };
  } catch {
    return { descriptive_name: '', currency_code: '', time_zone: '', is_manager: false };
  }
}

export const googleAdsAccountService = {
  // List directly-accessible customers via a refresh token. Used right after
  // OAuth (before any connection is persisted) so we accept the encrypted
  // blob directly rather than a connection object.
  async listAccessibleFromGrant(refresh_token_enc: EncryptedBlob): Promise<string[]> {
    const refresh_token = decryptSecret(refresh_token_enc);
    const res = await googleAdsApi().listAccessibleCustomers(refresh_token);
    return (res.resource_names ?? []).map((n) => customerIdFromResourceName(n));
  },

  // Same call but using a persisted connection.
  async listAccessible(connection: GoogleAdsConnection): Promise<string[]> {
    const names = await listAccessibleResourceNames(connection);
    return names.map((n) => customerIdFromResourceName(n));
  },

  // BFS the customer_client tree from `rootCustomerId`. Returns every node
  // (manager or leaf) so the user can multi-select either MCCs or children.
  async discoverHierarchy(args: {
    refresh_token_enc: EncryptedBlob;
    rootCustomerId: string;
  }): Promise<GoogleAdsCandidate[]> {
    const seen = new Set<string>();
    const queue: string[] = [args.rootCustomerId];
    const out: GoogleAdsCandidate[] = [];

    const refresh_token = decryptSecret(args.refresh_token_enc);
    const api = googleAdsApi();

    while (queue.length > 0) {
      const managerId = queue.shift()!;
      if (seen.has(managerId)) continue;
      seen.add(managerId);

      const customer = api.Customer({
        customer_id: managerId,
        refresh_token,
        login_customer_id: args.rootCustomerId,
      });

      let rows: ClientLikeRow[] = [];
      try {
        rows = (await customer.query(
          `SELECT customer_client.client_customer,
                  customer_client.level,
                  customer_client.manager,
                  customer_client.descriptive_name,
                  customer_client.currency_code,
                  customer_client.time_zone,
                  customer_client.id
           FROM customer_client
           WHERE customer_client.level <= 1`
        )) as unknown as ClientLikeRow[];
      } catch {
        // Account is not a manager (no customer_client table). Treat as a leaf.
        continue;
      }

      for (const row of rows) {
        const cand = rowToCandidate(row, args.rootCustomerId);
        if (!cand) continue;
        if (cand.customer_id === managerId) continue;
        out.push(cand);
        if (cand.is_manager && !seen.has(cand.customer_id)) {
          queue.push(cand.customer_id);
        }
      }
    }
    return dedupeById(out);
  },

  fetchCustomerMetadata,

  // Live fetch + 5-min cache. Pass connection because routing always knows
  // which connection it's targeting.
  async listConversionActions(args: {
    connection: GoogleAdsConnection;
    forceRefresh?: boolean;
  }): Promise<GoogleAdsConversionAction[]> {
    const cacheKey = args.connection.connection_id;
    const now = Date.now();
    if (!args.forceRefresh) {
      const hit = conversionActionCache.get(cacheKey);
      if (hit && hit.expires > now) return hit.actions;
    }

    const refresh_token = decryptSecret(args.connection.refresh_token_enc);
    const customer = googleAdsApi().Customer({
      customer_id: args.connection.customer_id,
      refresh_token,
      login_customer_id: args.connection.manager_customer_id,
    });

    const rows = (await customer.query(
      `SELECT conversion_action.resource_name,
              conversion_action.id,
              conversion_action.name,
              conversion_action.status,
              conversion_action.type,
              conversion_action.category
       FROM conversion_action
       WHERE conversion_action.type = 'UPLOAD_CLICKS'`
    )) as unknown as Array<{
      conversion_action?: {
        resource_name?: string;
        id?: string | number | { toString(): string };
        name?: string;
        status?: string | number | { toString(): string };
        type?: string | number | { toString(): string };
        category?: string | number | { toString(): string };
      };
    }>;

    const actions: GoogleAdsConversionAction[] = rows
      .map((r) => r.conversion_action)
      .filter((c): c is NonNullable<typeof c> => !!c?.resource_name)
      .map((c) => ({
        resource_name: String(c.resource_name),
        id: String(c.id ?? ''),
        name: String(c.name ?? ''),
        status: String(c.status ?? ''),
        type: String(c.type ?? ''),
        category: c.category != null ? String(c.category) : undefined,
      }));

    conversionActionCache.set(cacheKey, { actions, expires: now + CONVERSION_ACTION_TTL_MS });
    return actions;
  },

  invalidateConversionActions(): void {
    conversionActionCache.clear();
  },
};

function dedupeById(list: GoogleAdsCandidate[]): GoogleAdsCandidate[] {
  const seen = new Map<string, GoogleAdsCandidate>();
  for (const c of list) {
    const prev = seen.get(c.customer_id);
    if (!prev || (prev.descriptive_name === '' && c.descriptive_name !== '')) {
      seen.set(c.customer_id, c);
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    (a.descriptive_name || a.customer_id).localeCompare(b.descriptive_name || b.customer_id)
  );
}

import { facebookGraphApi, META_STANDARD_EVENTS, type AdAccountSummary } from './facebookGraphClient';
import { decryptSecret } from '../utils/crypto';
import type { EncryptedBlob } from '../utils/crypto';
import type {
  FacebookCandidate,
  FacebookConnection,
  FacebookCustomEvent,
} from '../types/facebookAds';

// Per-connection 5-min cache for the conversion-event picker — mirrors
// the GAds equivalent in ./googleAdsAccountService.ts.
const CUSTOM_EVENT_TTL_MS = 5 * 60 * 1000;
const customEventCache = new Map<string, { actions: FacebookCustomEvent[]; expires: number }>();

// Per-connection 5-min cache for the dataset list. Same rationale.
const DATASET_TTL_MS = 5 * 60 * 1000;
const datasetCache = new Map<string, { datasets: Array<{ id: string; name: string }>; expires: number }>();

export const facebookAccountService = {
  // Used right after OAuth (before any connection is persisted) so we accept
  // the encrypted blob directly instead of a connection record. Returns BMs
  // + directly-owned ad accounts in a single flat candidate list keyed by
  // the candidate's `type` field.
  async listAccessibleFromGrant(access_token_enc: EncryptedBlob): Promise<FacebookCandidate[]> {
    const token = decryptSecret(access_token_enc);
    return await collectCandidates(token);
  },

  async listAccessible(connection: FacebookConnection): Promise<FacebookCandidate[]> {
    const token = decryptSecret(connection.access_token_enc);
    return await collectCandidates(token);
  },

  // Picks up the (possibly-larger) child-ad-account set under a BM. Mirrors
  // ../services/googleAdsAccountService.discoverHierarchy. Used by both the
  // initial finalize flow (to snapshot the children for display) and the
  // "Refresh accounts" button on a persisted BM connection.
  async discoverBusinessAdAccounts(args: {
    access_token_enc: EncryptedBlob;
    businessId: string;
  }): Promise<AdAccountSummary[]> {
    const token = decryptSecret(args.access_token_enc);
    return await facebookGraphApi.listAdAccountsForBusiness(token, args.businessId);
  },

  async fetchAdAccountMetadata(args: {
    access_token_enc: EncryptedBlob;
    ad_account_id: string;
  }): Promise<AdAccountSummary | null> {
    const token = decryptSecret(args.access_token_enc);
    return await facebookGraphApi.getAdAccountMetadata(token, args.ad_account_id);
  },

  async fetchBusinessMetadata(args: {
    access_token_enc: EncryptedBlob;
    business_id: string;
  }): Promise<{ id: string; name: string } | null> {
    const token = decryptSecret(args.access_token_enc);
    return await facebookGraphApi.getBusinessMetadata(token, args.business_id);
  },

  async listDatasets(args: {
    connection: FacebookConnection;
    forceRefresh?: boolean;
  }): Promise<Array<{ id: string; name: string }>> {
    const cacheKey = args.connection.connection_id;
    const now = Date.now();
    if (!args.forceRefresh) {
      const hit = datasetCache.get(cacheKey);
      if (hit && hit.expires > now) return hit.datasets;
    }
    const token = decryptSecret(args.connection.access_token_enc);
    const datasets = await facebookGraphApi.listDatasetsForAdAccount(token, args.connection.ad_account_id);
    datasetCache.set(cacheKey, { datasets, expires: now + DATASET_TTL_MS });
    return datasets;
  },

  // Returns the full event picker contents for a dataset: every Meta standard
  // event plus any custom events the operator has registered. The picker
  // collapses both into one dropdown so the user picks by name.
  async listCustomEvents(args: {
    connection: FacebookConnection;
    dataset_id?: string;          // override the connection's default
    forceRefresh?: boolean;
  }): Promise<FacebookCustomEvent[]> {
    const datasetId = args.dataset_id || args.connection.dataset_id;
    if (!datasetId) {
      // No dataset = no custom events available, but the standard events
      // can still be returned so the dropdown isn't empty.
      return META_STANDARD_EVENTS.map((name) => ({
        dataset_id: '',
        event_name: name,
        kind: 'standard' as const,
      }));
    }
    const cacheKey = `${args.connection.connection_id}|${datasetId}`;
    const now = Date.now();
    if (!args.forceRefresh) {
      const hit = customEventCache.get(cacheKey);
      if (hit && hit.expires > now) return hit.actions;
    }
    const token = decryptSecret(args.connection.access_token_enc);
    const custom = await facebookGraphApi.listCustomEventsForDataset(token, datasetId);

    const all: FacebookCustomEvent[] = [
      ...META_STANDARD_EVENTS.map((name) => ({
        dataset_id: datasetId,
        event_name: name,
        kind: 'standard' as const,
      })),
      ...custom.map((c) => ({
        dataset_id: datasetId,
        event_name: c.name,
        kind: 'custom' as const,
        description: c.description,
      })),
    ];
    customEventCache.set(cacheKey, { actions: all, expires: now + CUSTOM_EVENT_TTL_MS });
    return all;
  },

  invalidateCustomEvents(): void {
    customEventCache.clear();
    datasetCache.clear();
  },
};

async function collectCandidates(accessToken: string): Promise<FacebookCandidate[]> {
  const out: FacebookCandidate[] = [];
  const seenAdAccounts = new Set<string>();
  const seenBusinesses = new Set<string>();

  const businesses = await facebookGraphApi.listBusinesses(accessToken).catch(() => []);
  for (const b of businesses) {
    if (seenBusinesses.has(b.id)) continue;
    seenBusinesses.add(b.id);
    out.push({
      type: 'business',
      id: b.id,
      name: b.name,
      currency_code: '',
      time_zone: '',
    });
    const adAccounts = await facebookGraphApi.listAdAccountsForBusiness(accessToken, b.id).catch(() => [] as AdAccountSummary[]);
    for (const a of adAccounts) {
      if (seenAdAccounts.has(a.id)) continue;
      seenAdAccounts.add(a.id);
      out.push({
        type: 'ad_account',
        id: a.id,
        business_id: b.id,
        name: a.name,
        currency_code: a.currency_code,
        time_zone: a.time_zone,
        account_status: a.account_status,
      });
    }
  }

  // Ad accounts the user has direct access to (no BM in between).
  const direct = await facebookGraphApi.listOwnedAdAccounts(accessToken).catch(() => [] as AdAccountSummary[]);
  for (const a of direct) {
    if (seenAdAccounts.has(a.id)) continue;
    seenAdAccounts.add(a.id);
    out.push({
      type: 'ad_account',
      id: a.id,
      business_id: a.business_id,
      name: a.name,
      currency_code: a.currency_code,
      time_zone: a.time_zone,
      account_status: a.account_status,
    });
  }
  return out;
}

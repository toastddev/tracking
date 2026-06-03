import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { FacebookRoute, FacebookRouteScope } from '../../types/facebookAds';

// Mirror of ./googleAdsRouteRepository.ts. Routes pin a specific
// (offer | network) onto an ad_account-typed connection with a specific
// dataset + event mapping. Offer overrides network when both match.

const TTL_MS = 60_000;
const cache = new Map<string, { route: FacebookRoute | null; expires: number }>();

function fromDoc(id: string, raw: Record<string, unknown>): FacebookRoute {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    route_id: id,
    scope_type: raw.scope_type as FacebookRouteScope,
    scope_id: String(raw.scope_id ?? ''),
    target_connection_id: String(raw.target_connection_id ?? ''),
    sale_event_name: raw.sale_event_name as string | undefined,
    sale_event_dataset_id: raw.sale_event_dataset_id as string | undefined,
    click_event_name: raw.click_event_name as string | undefined,
    click_event_dataset_id: raw.click_event_dataset_id as string | undefined,
    enabled: raw.enabled !== false,
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export function buildFbRouteId(scope_type: FacebookRouteScope, scope_id: string): string {
  return `${scope_type}_${scope_id}`;
}

export const facebookRouteRepository = {
  async upsert(route: Omit<FacebookRoute, 'created_at' | 'updated_at'>): Promise<FacebookRoute> {
    const ref = db().collection(COLLECTIONS.FACEBOOK_ROUTES).doc(route.route_id);
    const exists = (await ref.get()).exists;
    const payload: Record<string, unknown> = {
      scope_type: route.scope_type,
      scope_id: route.scope_id,
      target_connection_id: route.target_connection_id,
      sale_event_name: route.sale_event_name,
      sale_event_dataset_id: route.sale_event_dataset_id,
      click_event_name: route.click_event_name,
      click_event_dataset_id: route.click_event_dataset_id,
      enabled: route.enabled,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (!exists) payload.created_at = FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    cache.delete(route.route_id);
    const snap = await ref.get();
    return fromDoc(route.route_id, snap.data() ?? {});
  },

  async getById(route_id: string): Promise<FacebookRoute | null> {
    const now = Date.now();
    const hit = cache.get(route_id);
    if (hit && hit.expires > now) return hit.route;
    const snap = await db().collection(COLLECTIONS.FACEBOOK_ROUTES).doc(route_id).get();
    const route = snap.exists ? fromDoc(route_id, snap.data() ?? {}) : null;
    cache.set(route_id, { route, expires: now + TTL_MS });
    return route;
  },

  async resolveForConversion(
    offer_id: string | undefined,
    network_id: string
  ): Promise<FacebookRoute | null> {
    if (offer_id) {
      const offerRoute = await this.getById(buildFbRouteId('offer', offer_id));
      if (offerRoute && offerRoute.enabled) return offerRoute;
    }
    if (network_id) {
      const networkRoute = await this.getById(buildFbRouteId('network', network_id));
      if (networkRoute && networkRoute.enabled) return networkRoute;
    }
    return null;
  },

  async resolveForOffer(offer_id: string): Promise<FacebookRoute | null> {
    if (!offer_id) return null;
    const r = await this.getById(buildFbRouteId('offer', offer_id));
    return r && r.enabled ? r : null;
  },

  async listAll(): Promise<FacebookRoute[]> {
    const snap = await db().collection(COLLECTIONS.FACEBOOK_ROUTES).limit(500).get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async delete(route_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.FACEBOOK_ROUTES).doc(route_id);
    const exists = (await ref.get()).exists;
    if (!exists) return false;
    await ref.delete();
    cache.delete(route_id);
    return true;
  },

  invalidate(route_id?: string): void {
    if (route_id) cache.delete(route_id);
    else cache.clear();
  },
};

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { GoogleAdsRoute, GoogleAdsRouteScope } from '../../types/googleAds';

const TTL_MS = 60_000;
const cache = new Map<string, { route: GoogleAdsRoute | null; expires: number }>();

function fromDoc(id: string, raw: Record<string, unknown>): GoogleAdsRoute {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    route_id: id,
    scope_type: raw.scope_type as GoogleAdsRouteScope,
    scope_id: String(raw.scope_id ?? ''),
    target_connection_id: String(raw.target_connection_id ?? ''),
    sale_conversion_action_resource: raw.sale_conversion_action_resource as string | undefined,
    sale_conversion_action_name: raw.sale_conversion_action_name as string | undefined,
    click_conversion_action_resource: raw.click_conversion_action_resource as string | undefined,
    click_conversion_action_name: raw.click_conversion_action_name as string | undefined,
    enabled: raw.enabled !== false,
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export function buildRouteId(scope_type: GoogleAdsRouteScope, scope_id: string): string {
  return `${scope_type}_${scope_id}`;
}

export const googleAdsRouteRepository = {
  async upsert(route: Omit<GoogleAdsRoute, 'created_at' | 'updated_at'>): Promise<GoogleAdsRoute> {
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_ROUTES).doc(route.route_id);
    const exists = (await ref.get()).exists;
    const payload: Record<string, unknown> = {
      scope_type: route.scope_type,
      scope_id: route.scope_id,
      target_connection_id: route.target_connection_id,
      sale_conversion_action_resource: route.sale_conversion_action_resource,
      sale_conversion_action_name: route.sale_conversion_action_name,
      click_conversion_action_resource: route.click_conversion_action_resource,
      click_conversion_action_name: route.click_conversion_action_name,
      enabled: route.enabled,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (!exists) payload.created_at = FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    cache.delete(route.route_id);
    const snap = await ref.get();
    return fromDoc(route.route_id, snap.data() ?? {});
  },

  async getById(route_id: string): Promise<GoogleAdsRoute | null> {
    const now = Date.now();
    const hit = cache.get(route_id);
    if (hit && hit.expires > now) return hit.route;
    const snap = await db().collection(COLLECTIONS.GOOGLE_ADS_ROUTES).doc(route_id).get();
    const route = snap.exists ? fromDoc(route_id, snap.data() ?? {}) : null;
    cache.set(route_id, { route, expires: now + TTL_MS });
    return route;
  },

  // Offer-level overrides network-level. The result may be null when no
  // child-level mapping exists; the MCC fan-out path is independent.
  async resolveForConversion(
    offer_id: string | undefined,
    network_id: string
  ): Promise<GoogleAdsRoute | null> {
    if (offer_id) {
      const offerRoute = await this.getById(buildRouteId('offer', offer_id));
      if (offerRoute && offerRoute.enabled) return offerRoute;
    }
    if (network_id) {
      const networkRoute = await this.getById(buildRouteId('network', network_id));
      if (networkRoute && networkRoute.enabled) return networkRoute;
    }
    return null;
  },

  // Click-side resolution — only the offer scope makes sense for outbound
  // clicks (no network is involved at click time).
  async resolveForOffer(offer_id: string): Promise<GoogleAdsRoute | null> {
    if (!offer_id) return null;
    const r = await this.getById(buildRouteId('offer', offer_id));
    return r && r.enabled ? r : null;
  },

  async listAll(): Promise<GoogleAdsRoute[]> {
    const snap = await db().collection(COLLECTIONS.GOOGLE_ADS_ROUTES).limit(500).get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async delete(route_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_ROUTES).doc(route_id);
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

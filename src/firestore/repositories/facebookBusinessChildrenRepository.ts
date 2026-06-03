import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { FacebookBusinessChild } from '../../types/facebookAds';

// Display-only snapshot of the ad accounts under a BM connection. Mirrors
// ./googleAdsMccChildrenRepository.ts.

function fromDoc(id: string, raw: Record<string, unknown>): FacebookBusinessChild {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    fb_child_id: id,
    connection_id: String(raw.connection_id ?? ''),
    ad_account_id: String(raw.ad_account_id ?? ''),
    name: String(raw.name ?? ''),
    currency_code: String(raw.currency_code ?? ''),
    time_zone: String(raw.time_zone ?? ''),
    account_status: raw.account_status as string | undefined,
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export function buildFbChildId(connection_id: string, ad_account_id: string): string {
  return `${connection_id}_${ad_account_id}`;
}

export const facebookBusinessChildrenRepository = {
  async upsertMany(
    connection_id: string,
    children: Array<Omit<FacebookBusinessChild, 'fb_child_id' | 'connection_id' | 'created_at' | 'updated_at'>>
  ): Promise<FacebookBusinessChild[]> {
    const batch = db().batch();
    const out: { ref: FirebaseFirestore.DocumentReference; id: string }[] = [];
    for (const c of children) {
      const id = buildFbChildId(connection_id, c.ad_account_id);
      const ref = db().collection(COLLECTIONS.FACEBOOK_BUSINESS_CHILDREN).doc(id);
      batch.set(
        ref,
        {
          connection_id,
          ad_account_id: c.ad_account_id,
          name: c.name,
          currency_code: c.currency_code,
          time_zone: c.time_zone,
          account_status: c.account_status,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      out.push({ ref, id });
    }
    if (out.length === 0) return [];
    await batch.commit();
    const snaps = await Promise.all(out.map((x) => x.ref.get()));
    return snaps.map((s, i) => fromDoc(out[i]!.id, s.data() ?? {}));
  },

  async listByConnection(connection_id: string): Promise<FacebookBusinessChild[]> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_BUSINESS_CHILDREN)
      .where('connection_id', '==', connection_id)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async deleteByConnection(connection_id: string): Promise<void> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_BUSINESS_CHILDREN)
      .where('connection_id', '==', connection_id)
      .get();
    if (snap.empty) return;
    const batch = db().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  },
};

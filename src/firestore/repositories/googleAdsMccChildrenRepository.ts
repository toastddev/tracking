import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { GoogleAdsMccChild } from '../../types/googleAds';

function fromDoc(id: string, raw: Record<string, unknown>): GoogleAdsMccChild {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    ga_child_id: id,
    connection_id: String(raw.connection_id ?? ''),
    customer_id: String(raw.customer_id ?? ''),
    descriptive_name: String(raw.descriptive_name ?? ''),
    currency_code: String(raw.currency_code ?? ''),
    time_zone: String(raw.time_zone ?? ''),
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export function buildMccChildId(connection_id: string, customer_id: string): string {
  return `${connection_id}_${customer_id}`;
}

export const googleAdsMccChildrenRepository = {
  async upsertMany(connection_id: string, children: Array<Omit<GoogleAdsMccChild, 'ga_child_id' | 'connection_id' | 'created_at' | 'updated_at'>>): Promise<GoogleAdsMccChild[]> {
    const batch = db().batch();
    const out: { ref: FirebaseFirestore.DocumentReference; id: string }[] = [];
    for (const c of children) {
      const id = buildMccChildId(connection_id, c.customer_id);
      const ref = db().collection(COLLECTIONS.GOOGLE_ADS_MCC_CHILDREN).doc(id);
      batch.set(
        ref,
        {
          connection_id,
          customer_id: c.customer_id,
          descriptive_name: c.descriptive_name,
          currency_code: c.currency_code,
          time_zone: c.time_zone,
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

  async listByConnection(connection_id: string): Promise<GoogleAdsMccChild[]> {
    const snap = await db()
      .collection(COLLECTIONS.GOOGLE_ADS_MCC_CHILDREN)
      .where('connection_id', '==', connection_id)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async deleteByConnection(connection_id: string): Promise<void> {
    const snap = await db()
      .collection(COLLECTIONS.GOOGLE_ADS_MCC_CHILDREN)
      .where('connection_id', '==', connection_id)
      .get();
    if (snap.empty) return;
    const batch = db().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  },
};

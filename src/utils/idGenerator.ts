import { uuidv7 } from 'uuidv7';

// UUID v7 = 48-bit unix-ms timestamp prefix + 74 bits random + version/variant.
// Time-ordered IDs make range scans by created time efficient and let
// downstream consumers infer creation time without a separate column.
//
// Trade-off note: IDs created in the same millisecond share the timestamp
// prefix, which can briefly hotspot a Firestore partition under bursty load.
// The random suffix prevents perfect monotonicity, and Firestore auto-splits
// hot ranges within seconds — acceptable for our expected click QPS.
export function generateClickId(): string {
  return uuidv7();
}

export function generateConversionId(): string {
  return uuidv7();
}

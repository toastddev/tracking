import { type App, initializeApp, cert, getApps } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let _db: Firestore | null = null;

/**
 * Initialise the Firestore client.
 *
 * Credentials resolution order:
 *   1. FIREBASE_SERVICE_ACCOUNT env var (JSON string) — good for container deploys.
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON) — handled by the SDK's default.
 *   3. Application Default Credentials on GCP.
 */
export function initFirestore(): Firestore {
  if (_db) return _db;

  let app: App;
  if (getApps().length > 0) {
    app = getApps()[0]!;
  } else {
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
    app = initializeApp(
      inline ? { credential: cert(JSON.parse(inline)) } : undefined
    );
  }

  const databaseId = process.env.FIRESTORE_DATABASE_ID || 'tracking';

  _db = getFirestore(app, databaseId);
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}

export function db(): Firestore {
  return _db ?? initFirestore();
}

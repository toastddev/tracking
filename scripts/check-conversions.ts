import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envContent = fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf-8');
let serviceAccountStr = '';
for (const line of envContent.split('\n')) {
    if (line.startsWith('FIREBASE_SERVICE_ACCOUNT_KEY=')) {
        serviceAccountStr = line.substring('FIREBASE_SERVICE_ACCOUNT_KEY='.length).trim();
        // remove surrounding quotes if exist
        if (serviceAccountStr.startsWith("'") && serviceAccountStr.endsWith("'")) serviceAccountStr = serviceAccountStr.slice(1, -1);
        if (serviceAccountStr.startsWith('"') && serviceAccountStr.endsWith('"')) serviceAccountStr = serviceAccountStr.slice(1, -1);
        break;
    }
}

if (!serviceAccountStr) {
  console.error("No service account key found");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountStr)),
});

const db = admin.firestore();

async function main() {
  const conversionsRef = db.collection('conversions');
  const snap = await conversionsRef.get();

  const counts: Record<string, any> = {};

  snap.forEach(doc => {
    const data = doc.data();
    const offer = data.offer_name || data.offer_id || 'Unknown';
    if (!counts[offer]) {
      counts[offer] = {
        total: 0,
        total_payout: 0,
        verified: 0,
        shadow: 0,
        statuses: {},
        clickIds: new Set(),
        duplicates: 0,
      };
    }

    counts[offer].total++;
    counts[offer].total_payout += (data.payout || 0);
    
    if (data.verified) counts[offer].verified++;
    if (data.shadow) counts[offer].shadow++;
    
    counts[offer].statuses[data.status || 'none'] = (counts[offer].statuses[data.status || 'none'] || 0) + 1;

    if (data.click_id) {
        if (counts[offer].clickIds.has(data.click_id)) {
            counts[offer].duplicates++;
        } else {
            counts[offer].clickIds.add(data.click_id);
        }
    }
  });

  // remove clickIds set for printing
  for (const offer in counts) {
    counts[offer].unique_clicks = counts[offer].clickIds.size;
    delete counts[offer].clickIds;
  }

  console.log(JSON.stringify(counts, null, 2));
}

main().catch(console.error);

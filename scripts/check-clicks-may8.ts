import { initFirestore } from '../src/firestore';
import { db } from '../src/firestore/config';
import { COLLECTIONS } from '../src/firestore/schema';

async function run() {
  initFirestore();
  console.log('Querying clicks for May 8th...');

  // May 8th 2026 UTC
  const start = new Date('2026-05-08T00:00:00Z');
  const end = new Date('2026-05-08T23:59:59.999Z');

  const snap = await db()
    .collection(COLLECTIONS.CLICKS)
    .where('created_at', '>=', start)
    .where('created_at', '<=', end)
    .get();

  console.log(`Found ${snap.size} total clicks on May 8th.`);

  let dellClicks = 0;
  let directDellClicks = 0;

  snap.docs.forEach(doc => {
    const data = doc.data();
    const offerId = data.offer_id;
    
    if (offerId === 'dell') {
      dellClicks++;
    } else if (offerId === 'direct-dell') {
      directDellClicks++;
    }
  });

  console.log(`\nDell Clicks: ${dellClicks}`);
  console.log(`Direct-Dell Clicks: ${directDellClicks}`);
}

run().catch(console.error);

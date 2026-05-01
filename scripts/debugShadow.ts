import { initFirestore } from '../src/firestore';
import { db } from '../src/firestore/config';
import { AggregateField } from 'firebase-admin/firestore';

async function main() {
  initFirestore();
  
  const snap = await db().collection('conversions').where('shadow', '==', true).where('verified', '==', true).get();
  
  let payout = 0;
  for (const doc of snap.docs) {
    payout += doc.data().payout || 0;
  }
  
  console.log(`Shadow conversions: ${snap.size}`);
  console.log(`Shadow payout: ${payout}`);
  
  const allVerified = await db().collection('conversions').where('verified', '==', true).get();
  let allPayout = 0;
  let shadowPayout = 0;
  let normalPayout = 0;
  
  for (const doc of allVerified.docs) {
    const data = doc.data();
    allPayout += data.payout || 0;
    if (data.shadow) {
      shadowPayout += data.payout || 0;
    } else {
      normalPayout += data.payout || 0;
    }
  }
  
  console.log(`\nAll verified: ${allVerified.size}`);
  console.log(`Total payout: ${allPayout}`);
  console.log(`Normal payout: ${normalPayout}`);
  console.log(`Shadow payout: ${shadowPayout}`);
}

main().catch(console.error);

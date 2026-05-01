import { initFirestore } from '../src/firestore';
import { db } from '../src/firestore/config';

async function main() {
  initFirestore();
  
  const allVerified = await db().collection('conversions').where('verified', '==', true).count().get();
  console.log(`All verified: ${allVerified.data().count}`);
  
  const notTrue = await db().collection('conversions').where('verified', '==', true).where('shadow', '!=', true).count().get();
  console.log(`Where shadow != true: ${notTrue.data().count}`);
  
  const shadowTrue = await db().collection('conversions').where('verified', '==', true).where('shadow', '==', true).count().get();
  console.log(`Where shadow == true: ${shadowTrue.data().count}`);
  
  const missing = await db().collection('conversions').where('verified', '==', true).where('shadow', '==', null).count().get();
  console.log(`Where shadow == null: ${missing.data().count}`);
}

main().catch(console.error);

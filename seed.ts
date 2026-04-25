import { db } from './src/firestore/config';
import { FieldValue } from 'firebase-admin/firestore';

async function seed() {
  const firestore = db();

  console.log('Seeding offer...');
  await firestore.collection('offers').doc('test_offer').set({
    name: 'Test Store (Frontend Redirect)',
    base_url: 'https://your-frontend.com/redirect?cid={click_id}&destination=https://kelkoo.com/r?cid={click_id}',
    status: 'active',
    default_params: { utm_source: 'internal' },
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  console.log('Seeding network...');
  await firestore.collection('networks').doc('test_network').set({
    name: 'Test Network',
    status: 'active',
    mapping_click_id: 'cid',
    mapping_payout: 'revenue',
    mapping_currency: 'currency',
    mapping_status: 'status',
    default_status: 'approved',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  console.log('Database seeded successfully!');
  process.exit(0);
}

seed().catch(console.error);

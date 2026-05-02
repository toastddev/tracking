import { initFirestore } from './firestore';
import { googleAdsCampaignSyncService } from './services/googleAdsCampaignSyncService';
import { googleAdsConnectionRepository } from './firestore/repositories/googleAdsConnectionRepository';

async function main() {
  initFirestore();
  
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date();
  
  console.log('Running sync from', from, 'to', to);
  const children = await googleAdsConnectionRepository.listByType('child');
  const allConns = await googleAdsConnectionRepository.list();
  console.log('Found', allConns.length, 'total connections');
  for (const c of allConns) {
    console.log('  -', c.connection_id, c.type, c.status, c.customer_id);
    if (c.type === 'mcc') {
      const { googleAdsMccChildrenRepository } = await import('./firestore/repositories/googleAdsMccChildrenRepository');
      const mccChildren = await googleAdsMccChildrenRepository.listByConnection(c.connection_id);
      console.log('    Found', mccChildren.length, 'mcc children');
      for (const m of mccChildren) {
        console.log('      -', m.customer_id, m.descriptive_name);
      }
    }
  }
  console.log('Found', children.length, 'child connections');

  const result = await googleAdsCampaignSyncService.syncCampaigns({ from, to });
  console.log('Result:', result);
}

main().catch(console.error);

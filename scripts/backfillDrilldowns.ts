import { initFirestore } from '../src/firestore';
import { drilldownsBackfillService } from '../src/services/drilldownsBackfillService';

async function main() {
  console.log('Initializing Firestore...');
  initFirestore();
  
  console.log('Starting drilldowns backfill...');
  
  // Default is 120 days.
  const result = await drilldownsBackfillService.rebuild();
  
  console.log('Backfill complete!');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);

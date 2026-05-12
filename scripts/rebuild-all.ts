// import removed

import { campaignReportsBackfillService } from '../src/services/campaignReportsBackfillService';
import { offerReportsBackfillService } from '../src/services/offerReportsBackfillService';
import { drilldownsBackfillService } from '../src/services/drilldownsBackfillService';

async function run() {
  console.log('Rebuilding campaign reports...');
  await campaignReportsBackfillService.rebuild();
  console.log('Rebuilding offer reports...');
  await offerReportsBackfillService.rebuild();
  console.log('Rebuilding drilldowns...');
  await drilldownsBackfillService.rebuild();
  console.log('All rebuilt successfully!');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

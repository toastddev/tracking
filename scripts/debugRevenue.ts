import { initFirestore } from '../src/firestore';
import { db } from '../src/firestore/config';
import { offerReportDetailService } from '../src/services/offerReportDetailService';

async function main() {
  initFirestore();
  
  const from = new Date("2026-04-01T00:00:00Z");
  const to = new Date("2026-05-02T00:00:00Z");
  
  const snap = await db().collection('offer_reports').get();
  const offerIds = new Set<string>();
  snap.docs.forEach(d => offerIds.add(d.data().offer_id));
  
  for (const offer_id of offerIds) {
    const detail = await offerReportDetailService.getDetail({ offer_id, from, to });
    if (detail.summary.revenue > 2000 || detail.summary.clicks > 2000) {
      console.log(`\nOffer: ${offer_id}`);
      console.log(`Summary Revenue: ${detail.summary.revenue}`);
      console.log(`Summary Clicks: ${detail.summary.clicks}`);
      
      const seriesRev = detail.series.reduce((sum, p) => sum + p.revenue, 0);
      const seriesClicks = detail.series.reduce((sum, p) => sum + p.clicks, 0);
      console.log(`Series Revenue: ${seriesRev}`);
      console.log(`Series Clicks: ${seriesClicks}`);
    }
  }
}

main().catch(console.error);

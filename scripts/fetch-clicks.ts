import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import * as xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';

// Slugs to filter by. You can add more here.
const targetSlugs = [
  'dell',
  'direct-dell',
  'bedbathandbeyond',
  'direct-bedbathandbeyond',
  'direct-bestbuy',
  'penny-bestbuy',
  'direct-lg',
  'direct-zennioptical',
  'penny-zennioptical',
  'direct-vividseats',
  'penny-vividseats',
];

// Target date (YYYY-MM-DD)
// You can set this to whatever date you want
const targetDateStr = '2026-05-08';

async function run() {
  const serviceAccountPath = path.resolve('serviceAccount.json');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found at ${serviceAccountPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  const db = getFirestore('tracking');

  const startDate = new Date(`${targetDateStr}T00:00:00.000Z`);
  const endDate = new Date(`${targetDateStr}T23:59:59.999Z`);

  console.log(`Fetching clicks from ${startDate.toISOString()} to ${endDate.toISOString()}...`);

  const clicksRef = db.collection('clicks');

  // We query using Date objects because Firestore will automatically 
  // convert them to Firestore Timestamps for the query comparison,
  // which works if the db stores them as Timestamps or strings!
  // Wait, if it's stored as a string, querying with Date object might fail. 
  // We should query both or just fetch a broad range and filter.
  // Actually, we will query by Date objects since it appears they are Timestamps.
  const snapshot = await clicksRef
    .where('created_at', '>=', startDate)
    .where('created_at', '<=', endDate)
    .get();

  // If the query above returned 0, it might be because the fields are strings in the DB.
  let docs = snapshot.docs;
  if (docs.length === 0) {
    console.log("No docs found using Date objects, trying string comparison...");
    const strSnapshot = await clicksRef
      .where('created_at', '>=', startDate.toISOString())
      .where('created_at', '<=', endDate.toISOString())
      .get();
    docs = strSnapshot.docs;
  }

  console.log(`Found ${docs.length} total clicks in this date range.`);

  const filteredClicks = docs
    .map(doc => {
      const data = doc.data();

      // Handle the case where created_at is a Firestore Timestamp
      let createdAtStr = '';
      if (data.created_at && typeof data.created_at.toDate === 'function') {
        createdAtStr = data.created_at.toDate().toISOString();
      } else {
        createdAtStr = data.created_at || '';
      }

      return {
        click_id: doc.id,
        offer_id: data.offer_id || '',
        aff_id: data.aff_id || '',
        campaign_id: data.extra_params?.gad_campaignid || data.extra_params?.utm_campaign || '',
        redirect_url: data.redirect_url || '',
        ip: data.ip || '',
        user_agent: data.user_agent || '',
        referrer: data.referrer || '',
        country: data.country || '',
        created_at: createdAtStr,
        // Flatten ad IDs and sub params if needed
        gclid: data.ad_ids?.gclid || '',
        s1: data.sub_params?.s1 || '',
        s2: data.sub_params?.s2 || '',
      };
    })
    .filter(data =>
      targetSlugs.includes(data.offer_id) ||
      targetSlugs.includes(data.campaign_id) ||
      targetSlugs.includes(data.aff_id)
    );

  console.log(`Filtered down to ${filteredClicks.length} clicks matching the slugs.`);

  if (filteredClicks.length === 0) {
    console.log('No matching clicks found to export.');
    return;
  }

  // Create Excel
  const ws = xlsx.utils.json_to_sheet(filteredClicks);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Clicks");

  const outputPath = path.resolve(`clicks_${targetDateStr}_UTC.xlsx`);
  xlsx.writeFile(wb, outputPath);

  console.log(`Successfully exported to ${outputPath}`);
}

run().catch(console.error);

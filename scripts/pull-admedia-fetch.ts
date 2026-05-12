import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

const AID = '122250';
const AUTH = '2fb42a467452b41e946c29860736afb6';
const PAGE_SIZE = 100; // AdMedia caps responses at 100 per page regardless of limit param

const date = process.argv[2] ?? '2026-04-17';
const START_DATE = date;
const END_DATE = date;
const OUTPUT_FILE = `admedia_${date.replace(/-/g, '')}.csv`;

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
  numberParseOptions: { leadingZeros: false, hex: false, skipLike: /.*/ },
});

function buildUrl(page: number): string {
  return `http://api.admedia.com/param_cpc_report.php?aid=${AID}&auth=${AUTH}&start_date=${START_DATE}&end_date=${END_DATE}&page=${page}&limit=${PAGE_SIZE}`;
}

function escape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function fetchPage(page: number): Promise<unknown[]> {
  const url = buildUrl(page);
  console.log(`  Fetching page ${page}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
  const text = await res.text();

  const parsed = parser.parse(text);
  const listings = parsed?.dsxout?.data?.listing ?? parsed?.dsxout?.listing ?? parsed?.data?.listing;
  if (!listings) {
    // Log structure on page 1 to help debug unexpected shapes
    if (page === 1) console.log('Raw XML snippet:', text.slice(0, 500));
    return [];
  }
  return Array.isArray(listings) ? listings : [listings];
}

async function run() {
  console.log(`Pulling AdMedia CPC report for ${START_DATE}…`);

  const allItems: unknown[] = [];
  let page = 1;

  while (true) {
    const items = await fetchPage(page);
    console.log(`  Page ${page}: ${items.length} records`);
    if (items.length === 0) break;
    allItems.push(...items);
    // Stop if this page returned fewer than PAGE_SIZE — no more pages
    if (items.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`\nTotal records fetched: ${allItems.length}`);
  if (allItems.length === 0) {
    console.log('No data found.');
    return;
  }

  // Discover all field names from all items
  const fieldSet = new Set<string>();
  for (const item of allItems) {
    for (const k of Object.keys(item as object)) fieldSet.add(k);
  }
  // Put important fields first
  const priorityFields = ['id', 'Date', 'ClickID', 'CPC', 'currency', 'status'];
  const otherFields = [...fieldSet].filter(f => !priorityFields.includes(f)).sort();
  const fields = [...priorityFields.filter(f => fieldSet.has(f)), ...otherFields];

  console.log('Fields found:', fields.join(', '));

  // Build CSV
  let csv = fields.join(',') + '\n';
  for (const item of allItems) {
    const row = item as Record<string, unknown>;
    csv += fields.map(f => escape(row[f])).join(',') + '\n';
  }

  fs.writeFileSync(OUTPUT_FILE, csv, 'utf8');
  console.log(`\nSaved ${allItems.length} records to ${OUTPUT_FILE}`);
}

run().catch(console.error);

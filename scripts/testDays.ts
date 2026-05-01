const DAY_MS = 24 * 60 * 60 * 1000;

function eachDayKeyUTC(from: Date, to: Date): string[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const from = new Date("2026-04-01T21:17:59.580Z");
const to = new Date("2026-05-01T21:17:59.580Z");
console.log(eachDayKeyUTC(from, to).length);
console.log(eachDayKeyUTC(from, to));

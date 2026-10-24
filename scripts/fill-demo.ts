#!/usr/bin/env node
// Fills the missing structure of a demo khata, so every table has its columns filled for a demo.
//   node dist-server/scripts/fill-demo.js data/gupta.json [--apply]                          (a JSON khata file)
//   DATABASE_URL=... STORE=pg-schema node dist-server/scripts/fill-demo.js --shop gupta [--apply]   (a shop in the database)
// Dry run by default: prints what it would change. --apply writes it.
//   - every item in the rate book gets a realistic unit (maggi -> pkt, cheeni -> kg, tel -> l, ...) if it has none;
//   - every item gets a Nagpur wholesale buying rate (traderRate -> items.trader_rate) below its selling rate, if it has none;
//   - DEMO customers only (fake numbers such as 98765 0xxxx, or marked demo: true) get a name, a fake phone, a due date
//     and a few varied transactions if they have fewer than three.
// Customers with a real-looking number (or no number and no demo mark) are never touched. Running it twice changes nothing.

import type { Row } from '../server/tables';
import type { State } from '../core/types';

// A demo khata file may be old or hand-edited, so it is read as an open record (Row) and every field is checked before use.
type Pg = typeof import('pg');
export interface FillOpts { today?: string; pg?: Pg }

// usual unit and Nagpur wholesale margin (buying rate = selling rate x factor) by item key / spoken name
const CATALOG: [RegExp, string, number][] = [
  [/^(chini|cheeni|shakkar|sugar)/, 'kg', 0.9], [/^(ata|aata|atta|gehu)/, 'kg', 0.88], [/^(chaval|chawal|rice|basmati)/, 'kg', 0.85],
  [/^(dal|daal|tur|toor|moong|chana dal|masoor)/, 'kg', 0.87], [/^(besan)/, 'kg', 0.86], [/^(rava|suji|sooji|maida|poha)/, 'kg', 0.85],
  [/^(tel|oil|sarso|soyabean|mungfali)/, 'l', 0.9], [/^(ghee|ghi)/, 'kg', 0.9], [/^(dudh|doodh|milk)/, 'pkt', 0.92],
  [/^(dahi|curd)/, 'pkt', 0.85], [/^(paneer|panir)/, 'kg', 0.85], [/^(makhan|butter|amul butter)/, 'pkt', 0.9],
  [/^(magi|maggi|noodle|yippee)/, 'pkt', 0.86], [/^(biscuit|parle|good ?day|marie|bourbon)/, 'pkt', 0.85],
  [/^(bread|pav|rusk|toast)/, 'pkt', 0.85], [/^(chai|tea|chai patti)/, 'pkt', 0.85], [/^(coffee)/, 'pkt', 0.85],
  [/^(sabun|soap|lux|lifebuoy|dettol)/, 'pc', 0.82], [/^(surf|detergent|nirma|tide|wheel|rin)/, 'pkt', 0.85],
  [/^(shampoo)/, 'pkt', 0.8], [/^(toothpaste|colgate|pepsodent)/, 'pc', 0.82], [/^(namak|salt)/, 'pkt', 0.8],
  [/^(masala|mirch|haldi|dhaniya|jeera)/, 'pkt', 0.8], [/^(anda|egg)/, 'dozen', 0.88], [/^(cold drink|pepsi|coke|thums|sprite|bisleri|pani|water)/, 'bottle', 0.82],
  [/^(chips|kurkure|lays|namkeen)/, 'pkt', 0.8], [/^(match|machis|agarbatti)/, 'pkt', 0.75], [/^(gas|cylinder)/, 'pc', 0.95]
];
const DEFAULT: [string, number] = ['pc', 0.85];
const DEMO_ITEMS: [string, string, number][] = [['cheeni', 'kg', 45], ['atta', 'kg', 42], ['maggi', 'pkt', 14], ['biscuit', 'pkt', 10], ['doodh', 'pkt', 30], ['tel', 'l', 180], ['chawal', 'kg', 60], ['sabun', 'pc', 35]];

const lookup = (key: string, name: unknown): [string, number] => { for (const [rx, unit, f] of CATALOG) if (rx.test(String(key || '')) || rx.test(String(name || '').toLowerCase())) return [unit, f]; return DEFAULT; };
const hashOf = (s: unknown) => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** True for numbers that are obviously not a real person's: the app's seed range, repeated or sequential digits. */
function isFakePhone(p: unknown): boolean {
  const d = String(p == null ? '' : p).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  if (!d) return false;
  return /^987650\d{4}$/.test(d) || /^(\d)\1{9}$/.test(d) || d === '1234567890' || d === '9876543210' || /^0/.test(d) || /^9{5}0{4}/.test(d);
}
const isDemoCustomer = (c: Row | null | undefined) => c && (c.demo === true ? !c.phone || isFakePhone(c.phone) : isFakePhone(c.phone));

function nextId(state: Row, p: string): string { state.seqs = state.seqs || {}; state.seqs[p] = (state.seqs[p] || 0) + 1; return p + String(state.seqs[p]).padStart(3, '0'); }

/** Pure apart from mutating `state`. Returns the list of changes (empty when there is nothing to fill). */
function fillDemo(state: Row, opts?: FillOpts | null): string[] {
  opts = opts || {};
  const today: string = opts.today || state.today || new Date().toISOString().slice(0, 10);
  const changes: string[] = [];
  if (!state || typeof state !== 'object' || !state.shop) throw new Error('not a khata (no "shop")');

  // items
  if (!state.prices || typeof state.prices !== 'object') state.prices = {};
  for (const [key, p] of Object.entries(state.prices as Row)) {
    if (!p || typeof p !== 'object') continue;
    const [unit, f] = lookup(key, p.name);
    if (!p.unit) { p.unit = unit; changes.push('item ' + (p.name || key) + ': unit ' + unit); }
    if (!(typeof p.traderRate === 'number' && p.traderRate > 0 && (!(p.rate > 0) || p.traderRate < p.rate)) && p.rate > 0) {
      const tr = Math.max(0.5, Math.round(p.rate * f * 2) / 2);
      p.traderRate = tr < p.rate ? tr : Math.round((p.rate - 0.5) * 100) / 100;
      changes.push('item ' + (p.name || key) + ': trader rate ' + p.traderRate + ' (sells at ' + p.rate + ')');
    }
  }

  // demo customers
  const customers: Row[] = Array.isArray(state.customers) ? state.customers : [];
  if (!Array.isArray(state.txns)) state.txns = [];
  const used = new Set(customers.map((c) => String(c.phone || '').replace(/\D/g, '')).filter(Boolean));
  const names = Object.values(state.prices as Row).filter((p) => p && p.rate > 0);
  const pick: Row[] = names.length ? names : DEMO_ITEMS.map(([name, unit, rate]) => ({ name, unit, rate }));
  customers.forEach((c, i) => {
    if (!isDemoCustomer(c)) return;
    const h = hashOf(c.id || i);
    if (!c.name || !String(c.name).trim()) { c.name = 'Demo Grahak ' + (i + 1); changes.push(c.id + ': name ' + c.name); }
    if (!c.phone) {
      let n = 1; let ph;
      do { ph = '987650' + String((h + n++) % 10000).padStart(4, '0'); } while (used.has(ph));
      used.add(ph); c.phone = ph; changes.push(c.id + ': fake phone ' + ph);
    }
    const mine = state.txns.filter((t: Row) => t.custId === c.id && !t.voided);
    if (mine.length < 3) {
      const need = 3 - mine.length;
      for (let k = 0; k < need; k++) {
        const it = pick[(h + k) % pick.length], qty = 1 + ((h >> (k + 1)) % 3);
        const date = addDays(today, -(14 - k * 4 - (h % 3)));
        if (k === 1) {
          const amount = 50 + 10 * ((h >> 3) % 10);
          state.txns.push({ id: nextId(state, 'T'), custId: c.id, type: 'payment', amount, date, note: 'demo', source: 'demo' });
          changes.push(c.id + ': demo payment ' + amount);
        } else {
          const amount = Math.round(it.rate * qty);
          state.txns.push({ id: nextId(state, 'T'), custId: c.id, type: 'credit', amount, items: qty + ' ' + (it.unit || '') + ' ' + it.name, lines: [{ name: it.name, qty, unit: it.unit || null, price: amount }], date, dueDate: addDays(date, 7), note: 'demo', source: 'demo' });
          changes.push(c.id + ': demo udhaar ' + amount + ' (' + it.name + ')');
        }
      }
    }
    if (!c.dueDate) { c.dueDate = addDays(today, 3 + (h % 8)); changes.push(c.id + ': due date ' + c.dueDate); }
  });
  return changes;
}

async function run(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void, opts?: FillOpts | null): Promise<number> {
  opts = opts || {};
  const apply = argv.includes('--apply');
  const si = argv.indexOf('--shop');
  const shopId = si >= 0 ? argv[si + 1] : null;
  const file = argv.filter((a, i) => !a.startsWith('--') && !(si >= 0 && i === si + 1))[0];
  if (!file && !shopId) { out('usage: fill-demo.js <khata.json> [--apply]  |  fill-demo.js --shop <id> [--apply]  (DATABASE_URL, STORE)'); return 2; }
  if (file) {
    const fs: typeof import('fs') = require('fs');
    let state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out('cannot read ' + file + ': ' + (e as Error).message); return 1; }
    const changes = fillDemo(state, opts);
    report(changes, out, apply);
    if (apply && changes.length) { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); }
    return 0;
  }
  if (!env.DATABASE_URL) { out('DATABASE_URL is not set'); return 2; }
  const { makerFor }: typeof import('../server/store') = require('../server/store.js');
  const store = await makerFor(env.STORE)(env.DATABASE_URL, shopId!, { pg: opts.pg });
  try {
    const state = store.load();
    if (!state || !state.shop) { out('shop ' + shopId + ' has no khata in the database'); return 1; }
    const changes = fillDemo(state, opts);
    report(changes, out, apply);
    if (apply && changes.length) { store.save(state as State); await store.flush(); if (store.lastError) { out('write failed: ' + store.lastError); return 1; } }
    return 0;
  } finally { await store.close(); }
}
function report(changes: string[], out: (line: string) => void, apply: boolean) {
  for (const c of changes) out('  ' + c);
  out(changes.length ? (apply ? 'applied ' : 'dry run, would apply ') + changes.length + ' changes' + (apply ? '' : '. Use --apply.') : 'nothing to fill');
}

export { fillDemo, isFakePhone, isDemoCustomer, run };
if (require.main === module) run(process.argv.slice(2), process.env, console.log).then((c) => process.exit(c), (e) => { console.error('failed: ' + (e as Error).message); process.exit(1); });

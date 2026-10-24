// Owner login and the shop's registration profile (GSTIN, or PAN when the shop is not GST registered).
//   - passwords/PINs: scrypt with a random salt (node:crypto), compared in constant time; never stored or logged in clear
//   - sessions: a random token in an HttpOnly, Secure, SameSite=Strict cookie; only its sha256 is stored; expires
//   - lockout: OWNER_MAX_FAILS (default 5) wrong passwords for one phone lock it for OWNER_LOCK_MIN (default 15) minutes
//   - first owner: only while no owner exists, and only with the shop's ADMIN_KEY, so a visitor cannot claim the shop
//   - GSTIN / PAN: format and checksum only (not checked with the government); stored encrypted with TAX_ID_KEY when it is
//     set (AES-256-GCM), the page only ever gets the last 4 characters; never logged, never in the khata, never on WhatsApp
// Storage: data/<shop>.auth.json (default), or the tables in db/migrations/002_owner_auth.sql when DATABASE_URL is set
// (with DUAL_WRITE_JSON=1 the JSON file is written too). Kept outside the khata state on purpose.
import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import type * as PgModule from 'pg';

type Env = Record<string, string | undefined>;
export interface Owner { id: string; phone: string; name: string; hash: string; createdAt: string }
export interface Session { tokenHash: string; ownerId: string; expires: number }
export interface Profile {
  shopName: string; ownerName: string; address: string;
  gstRegistered: boolean; taxKind: 'GSTIN' | 'PAN' | null; taxIdEnc: string | null; taxLast4: string | null; updatedAt: string;
}
export interface AuthData { owners: Owner[]; sessions: Session[]; profile: Profile | null }
export interface AuthStore {
  readonly kind: string;
  readonly lastError?: string | null;
  load(): AuthData;
  save(d: AuthData): void;
  flush(): Promise<unknown>;
  close(): Promise<unknown>;
}

const empty = (): AuthData => ({ owners: [], sessions: [], profile: null });

// ---------- validation ----------

/** Indian mobile number -> its 10 digits, or null. Accepts +91, 91, 0 prefixes and spaces. */
function normPhone(v: unknown): string | null {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character a GSTIN must end with, from its first 14 (the published mod-36 scheme). */
function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = B36.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
}

function validPan(v: unknown): string | null {
  const s = String(v == null ? '' : v).toUpperCase().replace(/\s/g, '');
  return PAN_RE.test(s) ? s : null;
}

/** null if valid (returns the clean value via .value), else a reason the owner can act on. */
function checkGstin(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(v == null ? '' : v).toUpperCase().replace(/\s/g, '');
  if (s.length !== 15) return { ok: false, error: 'GSTIN must be 15 characters' };
  if (!GSTIN_RE.test(s)) return { ok: false, error: 'GSTIN format is wrong (2-digit state code, 10-character PAN, entity number, Z, check character)' };
  const st = +s.slice(0, 2);
  if (!((st >= 1 && st <= 38) || st === 97 || st === 99)) return { ok: false, error: 'GSTIN state code ' + s.slice(0, 2) + ' is not a valid state code' };
  if (!validPan(s.slice(2, 12))) return { ok: false, error: 'GSTIN does not contain a valid PAN' };
  if (gstinCheckChar(s.slice(0, 14)) !== s[14]) return { ok: false, error: 'GSTIN check character is wrong; please check for a typo' };
  return { ok: true, value: s };
}

/** Shows only the last 4 characters: XXXXXXXXXXX1ZV. */
function mask(v: string | null | undefined, len = 0): string {
  const s = String(v || '');
  if (!s) return '';
  return 'X'.repeat(Math.max(len || s.length, 4) - 4) + s.slice(-4);
}

// ---------- passwords ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), h.toString('base64')].join('$');
}
function verifyPassword(pw: string, stored: string): boolean {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  let got: Buffer;
  try { got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }); } catch (e) { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex')); // unknown phones cost the same time as known ones

/** 6+ characters; a 6-digit PIN is fine. */
function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 6) return 'Password or PIN must be at least 6 characters';
  if (pw.length > 200) return 'Password is too long';
  if (/^(\d)\1+$/.test(pw) || pw === '123456' || pw === '654321') return 'Please choose a less obvious PIN';
  return null;
}

// ---------- tax id at rest ----------

function taxKey(env: Env): Buffer | null {
  return env.TAX_ID_KEY ? crypto.createHash('sha256').update(String(env.TAX_ID_KEY)).digest() : null;
}
function sealTaxId(v: string, env: Env): string {
  const key = taxKey(env);
  if (!key) return 'plain:' + v;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return ['enc', 'v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function openTaxId(sealed: string | null, env: Env): string | null {
  if (!sealed) return null;
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  const [e, v, iv, tag, ct] = sealed.split(':');
  const key = taxKey(env);
  if (e !== 'enc' || v !== 'v1' || !key) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch (err) { return null; }
}

// ---------- stores ----------

function createFileAuthStore(dataDir: string, shopId: string): AuthStore {
  const file = path.join(dataDir, shopId + '.auth.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let data: AuthData = empty();
  try { data = Object.assign(empty(), JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  return {
    kind: 'file',
    load() { return data; },
    save(d: AuthData) {
      data = d;
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    flush() { return Promise.resolve(); },
    close() { return Promise.resolve(); }
  };
}

const AUTH_DDL = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '002_owner_auth.sql'), 'utf8');

async function createPgAuthStore(databaseUrl: string, shopId: string, opts?: { pg?: typeof PgModule; file?: AuthStore | null }): Promise<AuthStore> {
  const pg: typeof PgModule = (opts && opts.pg) || require('pg');
  const file = opts && opts.file;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  let data: AuthData;
  try {
    await pool.query(AUTH_DDL);
    const [o, s, p] = await Promise.all([
      pool.query('SELECT id, phone, name, password_hash, created_at FROM shop_owners WHERE shop_id = $1 ORDER BY created_at', [shopId]),
      pool.query('SELECT token_hash, owner_id, expires_at FROM owner_sessions WHERE shop_id = $1 AND expires_at > now()', [shopId]),
      pool.query('SELECT * FROM shop_profiles WHERE shop_id = $1', [shopId])
    ]);
    data = {
      owners: o.rows.map((r: any) => ({ id: r.id, phone: r.phone, name: r.name || '', hash: r.password_hash, createdAt: new Date(r.created_at).toISOString() })),
      sessions: s.rows.map((r: any) => ({ tokenHash: r.token_hash, ownerId: r.owner_id, expires: new Date(r.expires_at).getTime() })),
      profile: p.rows[0] ? { shopName: p.rows[0].shop_name || '', ownerName: p.rows[0].owner_name || '', address: p.rows[0].address || '', gstRegistered: !!p.rows[0].gst_registered,
        taxKind: p.rows[0].tax_kind, taxIdEnc: p.rows[0].tax_id_enc, taxLast4: p.rows[0].tax_last4, updatedAt: new Date(p.rows[0].updated_at).toISOString() } : null
    };
    // a database with no owner yet but a JSON file that has one (DUAL_WRITE_JSON backup): keep the file's
    if (!data.owners.length && file && file.load().owners.length) data = file.load();
  } catch (e) { await pool.end().catch(() => {}); throw e; }
  let chain: Promise<unknown> = Promise.resolve(), lastError: string | null = null;
  const write = async (d: AuthData) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM shop_owners WHERE shop_id = $1', [shopId]);
      for (const o of d.owners) await c.query('INSERT INTO shop_owners (shop_id, id, phone, name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [shopId, o.id, o.phone, o.name, o.hash, o.createdAt]);
      await c.query('DELETE FROM owner_sessions WHERE shop_id = $1', [shopId]);
      for (const s of d.sessions) await c.query('INSERT INTO owner_sessions (token_hash, shop_id, owner_id, expires_at) VALUES ($1,$2,$3,$4)', [s.tokenHash, shopId, s.ownerId, new Date(s.expires).toISOString()]);
      if (d.profile) {
        const p = d.profile;
        await c.query('INSERT INTO shop_profiles (shop_id, shop_name, owner_name, address, gst_registered, tax_kind, tax_id_enc, tax_last4, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) ' +
          'ON CONFLICT (shop_id) DO UPDATE SET shop_name = EXCLUDED.shop_name, owner_name = EXCLUDED.owner_name, address = EXCLUDED.address, gst_registered = EXCLUDED.gst_registered, ' +
          'tax_kind = EXCLUDED.tax_kind, tax_id_enc = EXCLUDED.tax_id_enc, tax_last4 = EXCLUDED.tax_last4, updated_at = now()',
        [shopId, p.shopName, p.ownerName, p.address, p.gstRegistered, p.taxKind, p.taxIdEnc, p.taxLast4]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  return {
    kind: 'pg',
    get lastError() { return lastError; },
    load() { return data; },
    save(d: AuthData) {
      data = d;
      if (file) { try { file.save(d); } catch (e) { console.error('Owner login JSON backup write failed'); } }
      const snap = JSON.parse(JSON.stringify(d));
      // the error text can quote a value; only its class is logged
      chain = chain.then(() => write(snap)).then(() => { lastError = null; }, (e) => { lastError = String((e && e.code) || 'error'); console.error('Owner login save to the database failed (' + lastError + ')'); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); }
  };
}

/** The file store, or the database (with the JSON file as backup under DUAL_WRITE_JSON=1); a database that is down falls back to the file. */
async function openAuthStore(env: Env, dataDir: string, shopId: string, opts?: { pg?: typeof PgModule; log?: (m: string) => void }): Promise<AuthStore> {
  const file = createFileAuthStore(dataDir, shopId);
  if (!env.DATABASE_URL) return file;
  try { return await createPgAuthStore(env.DATABASE_URL, env.SHOP_ID || shopId, { pg: opts && opts.pg, file: env.DUAL_WRITE_JSON === '1' ? file : null }); }
  catch (e: any) { (opts && opts.log || console.log)('Owner login: database not reachable (' + String(e && (e.code || e.name) || 'error') + '); using ' + shopId + '.auth.json'); return file; }
}

// ---------- the auth service ----------

export interface AuthOpts { env: Env; store: AuthStore; now?: () => number }
export type Result<T = {}> = ({ ok: true } & T) | { ok: false; code: number; error: string };
export interface ProfileInput { shopName?: unknown; ownerName?: unknown; address?: unknown; gstRegistered?: unknown; gstin?: unknown; pan?: unknown }

const COOKIE = 'udhaar_owner';
const str = (v: unknown, max: number) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function createAuth(o: AuthOpts) {
  const env = o.env, store = o.store, now = o.now || Date.now;
  const maxFails = +env.OWNER_MAX_FAILS! || 5, lockMs = (+env.OWNER_LOCK_MIN! || 15) * 60e3;
  const ttlMs = (+env.SESSION_DAYS! || 7) * 86400e3;
  const fails = new Map<string, { n: number; until: number }>();
  const data = () => store.load();
  const commit = (d: AuthData) => store.save(d);

  function cookieToken(header: unknown): string | null {
    for (const part of String(header || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=') || null;
    }
    return null;
  }
  /** The owner a request's cookie belongs to, or null. */
  function sessionOwner(cookieHeader: unknown): Owner | null {
    const t = cookieToken(cookieHeader);
    if (!t || t.length > 200) return null;
    const h = sha(t), d = data();
    const s = d.sessions.find((x) => x.tokenHash === h);
    if (!s || s.expires <= now()) return null;
    return d.owners.find((x) => x.id === s.ownerId) || null;
  }
  function newSession(d: AuthData, owner: Owner): string {
    const token = crypto.randomBytes(32).toString('base64url');
    d.sessions = d.sessions.filter((s) => s.expires > now()).slice(-19); // a few devices at most
    d.sessions.push({ tokenHash: sha(token), ownerId: owner.id, expires: now() + ttlMs });
    return token;
  }
  const setCookie = (token: string) => COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + Math.floor(ttlMs / 1000);
  const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

  function profileFrom(input: ProfileInput, prev: Profile | null): Result<{ profile: Profile }> {
    const shopName = str(input.shopName, 80), ownerName = str(input.ownerName, 80), address = str(input.address, 300);
    if (!shopName) return { ok: false, code: 400, error: 'Shop name is required' };
    if (!ownerName) return { ok: false, code: 400, error: 'Owner name is required' };
    if (!address) return { ok: false, code: 400, error: 'Address is required' };
    const gstRegistered = !(input.gstRegistered === false || input.gstRegistered === 'false' || input.gstRegistered === 0);
    const raw = gstRegistered ? input.gstin : input.pan;
    const given = str(raw, 40);
    let taxIdEnc = prev && prev.taxIdEnc, taxLast4 = prev && prev.taxLast4, taxKind = prev && prev.taxKind;
    const kind: 'GSTIN' | 'PAN' = gstRegistered ? 'GSTIN' : 'PAN';
    if (given) {
      let clean: string;
      if (gstRegistered) { const g = checkGstin(given); if (!g.ok) return { ok: false, code: 400, error: g.error }; clean = g.value; }
      else { const p = validPan(given); if (!p) return { ok: false, code: 400, error: 'PAN must look like ABCDE1234F (5 letters, 4 digits, 1 letter)' }; clean = p; }
      taxIdEnc = sealTaxId(clean, env); taxLast4 = clean.slice(-4); taxKind = kind;
    } else if (taxKind !== kind || !taxIdEnc) {
      return { ok: false, code: 400, error: gstRegistered ? 'GSTIN is required (or tick "Not GST registered" and give PAN)' : 'PAN is required when the shop is not GST registered' };
    }
    return { ok: true, profile: { shopName, ownerName, address, gstRegistered, taxKind: kind, taxIdEnc: taxIdEnc!, taxLast4: taxLast4!, updatedAt: new Date(now()).toISOString() } };
  }

  /** What the page may see: the tax id masked to its last 4. */
  function publicProfile(p: Profile | null) {
    if (!p) return null;
    return { shopName: p.shopName, ownerName: p.ownerName, address: p.address, gstRegistered: p.gstRegistered, taxKind: p.taxKind,
      taxIdMasked: p.taxLast4 ? mask(p.taxLast4, p.taxKind === 'GSTIN' ? 15 : 10) : '', encrypted: !!(p.taxIdEnc && p.taxIdEnc.startsWith('enc:')), verified: false, updatedAt: p.updatedAt };
  }

  return {
    COOKIE,
    sessionOwner,
    clearCookie,
    hasOwner: () => data().owners.length > 0,
    profile: () => publicProfile(data().profile),
    encryptionOn: () => !!taxKey(env),
    /** First owner: only when none exists, and only with ADMIN_KEY. */
    setup(input: Record<string, unknown>, adminOk: boolean): Result<{ cookie: string; owner: { phone: string; name: string } }> {
      if (!env.ADMIN_KEY) return { ok: false, code: 403, error: 'Owner setup needs the shop\'s ADMIN_KEY to be set on the server first' };
      if (!adminOk) return { ok: false, code: 403, error: 'Wrong admin key' };
      const d = data();
      if (d.owners.length) return { ok: false, code: 409, error: 'An owner account already exists. Please log in.' };
      const phone = normPhone(input.phone);
      if (!phone) return { ok: false, code: 400, error: 'Enter a 10-digit mobile number' };
      const bad = passwordProblem(input.password);
      if (bad) return { ok: false, code: 400, error: bad };
      const pr = profileFrom(input as ProfileInput, null);
      if (!pr.ok) return pr;
      const owner: Owner = { id: 'O' + crypto.randomBytes(6).toString('hex'), phone, name: pr.profile.ownerName, hash: hashPassword(String(input.password)), createdAt: new Date(now()).toISOString() };
      const next: AuthData = { owners: [owner], sessions: [], profile: pr.profile };
      const token = newSession(next, owner);
      commit(next);
      return { ok: true, cookie: setCookie(token), owner: { phone: mask(phone), name: owner.name } };
    },
    login(input: Record<string, unknown>): Result<{ cookie: string; owner: { phone: string; name: string } }> {
      const phone = normPhone(input.phone) || '';
      const key = phone || 'invalid';
      const f = fails.get(key);
      if (f && f.until > now()) return { ok: false, code: 429, error: 'Too many wrong tries. Try again in ' + Math.ceil((f.until - now()) / 60e3) + ' minute(s).' };
      const d = data();
      const owner = phone ? d.owners.find((x) => x.phone === phone) : undefined;
      const good = verifyPassword(String(input.password == null ? '' : input.password).slice(0, 200), owner ? owner.hash : DUMMY_HASH) && !!owner;
      if (!good) {
        const n = (f ? f.n : 0) + 1; // a lock that has run out was stored with n = 0, so counting starts again
        fails.set(key, n >= maxFails ? { n: 0, until: now() + lockMs } : { n, until: 0 });
        if (fails.size > 5000) for (const [k, v] of fails) if (!v.n && v.until <= now()) fails.delete(k);
        return n >= maxFails
          ? { ok: false, code: 429, error: 'Too many wrong tries. Try again in ' + Math.round(lockMs / 60e3) + ' minute(s).' }
          : { ok: false, code: 401, error: 'Wrong phone number or password' };
      }
      fails.delete(key);
      const next: AuthData = { owners: d.owners, sessions: d.sessions.slice(), profile: d.profile };
      const token = newSession(next, owner!);
      commit(next);
      return { ok: true, cookie: setCookie(token), owner: { phone: mask(owner!.phone), name: owner!.name } };
    },
    logout(cookieHeader: unknown) {
      const t = cookieToken(cookieHeader);
      if (!t) return;
      const d = data(), h = sha(t);
      if (d.sessions.some((s) => s.tokenHash === h)) commit({ owners: d.owners, sessions: d.sessions.filter((s) => s.tokenHash !== h), profile: d.profile });
    },
    changePassword(owner: Owner, input: Record<string, unknown>): Result {
      if (!verifyPassword(String(input.current || ''), owner.hash)) return { ok: false, code: 401, error: 'Current password is wrong' };
      const bad = passwordProblem(input.password);
      if (bad) return { ok: false, code: 400, error: bad };
      const d = data();
      commit({ owners: d.owners.map((x) => (x.id === owner.id ? Object.assign({}, x, { hash: hashPassword(String(input.password)) }) : x)), sessions: d.sessions, profile: d.profile });
      return { ok: true };
    },
    saveProfile(input: ProfileInput): Result<{ profile: ReturnType<typeof publicProfile> }> {
      const d = data();
      const pr = profileFrom(input, d.profile);
      if (!pr.ok) return pr;
      commit({ owners: d.owners, sessions: d.sessions, profile: pr.profile });
      return { ok: true, profile: publicProfile(pr.profile) };
    },
    /** The full tax id, for server-side use only (e.g. a future invoice); never sent to the page. */
    taxId: () => openTaxId(data().profile ? data().profile!.taxIdEnc : null, env)
  };
}
export type Auth = ReturnType<typeof createAuth>;

export { createAuth, createFileAuthStore, createPgAuthStore, openAuthStore, normPhone, checkGstin, gstinCheckChar, validPan, mask, hashPassword, verifyPassword, sealTaxId, openTaxId, passwordProblem };

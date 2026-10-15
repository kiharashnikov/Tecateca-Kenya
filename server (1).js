'use strict';
// Tecateca Kenya: store, partner portal and admin API. Zero dependencies (Node >= 22.13).
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
try { for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch {}
const E = (k, d = '') => process.env[k] ?? d;
const PROD = E('NODE_ENV') === 'production', PORT = +E('PORT', 3000), BASE = E('BASE_URL', `http://localhost:${PORT}`);
const MOCK = E('MPESA_MOCK', '1') === '1', SECRET = E('SESSION_SECRET', 'dev-secret'), CB = E('MPESA_CALLBACK_SECRET', 'dev-callback');
const DELIVERY = JSON.parse(E('DELIVERY', '{"Nairobi":250,"Kiambu":350,"Other":500}'));
const need = PROD ? ['SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'BASE_URL', 'MPESA_CALLBACK_SECRET'].concat(MOCK ? [] : ['MPESA_KEY', 'MPESA_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY']) : [];
for (const k of need) if (!E(k)) { console.error('Missing env ' + k); process.exit(1); }
if (PROD && MOCK) console.warn('WARNING: MPESA_MOCK=1 in production. Orders will be marked paid without real payment.');

fs.mkdirSync(path.dirname(E('DB_PATH', './data/tecateca.db')), { recursive: true });
const db = new DatabaseSync(E('DB_PATH', './data/tecateca.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pw TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pw TEXT NOT NULL,code TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'pending',rate REAL NOT NULL DEFAULT 10,mpesa TEXT DEFAULT '',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,kind TEXT NOT NULL,uid INTEGER NOT NULL,exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,size TEXT,category TEXT,price INTEGER NOT NULL CHECK(price>=0),stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,descr TEXT,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,user_id INTEGER,email TEXT,name TEXT NOT NULL,phone TEXT NOT NULL,area TEXT NOT NULL,subtotal INTEGER NOT NULL,delivery INTEGER NOT NULL,total INTEGER NOT NULL,ref TEXT,status TEXT NOT NULL DEFAULT 'pending',token TEXT NOT NULL,created INTEGER NOT NULL,paid_at INTEGER);
CREATE TABLE IF NOT EXISTS items(order_id INTEGER NOT NULL REFERENCES orders(id),product_id TEXT NOT NULL,qty INTEGER NOT NULL,price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),checkout_id TEXT UNIQUE,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',receipt TEXT,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commissions(id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id),partner_id INTEGER NOT NULL REFERENCES partners(id),amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,paid_at INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,title TEXT NOT NULL,date TEXT NOT NULL,place TEXT,note TEXT);
CREATE TABLE IF NOT EXISTS clicks(id INTEGER PRIMARY KEY,partner_id INTEGER NOT NULL,ts INTEGER NOT NULL);`);
if (!db.prepare('SELECT 1 FROM products').get()) {
  const P = [['ser','Calming Serum','30ml','Treat',3400],['amp','Calming Deep Ampoule','30ml','Treat',3800],['msk','Calming Serum in Mask','27ml x 6','Treat',2600],['pad','Calming Gauze Pad','70 pads, 105ml','Cleanse',2800],['tnr','Calming Water Toner','200ml','Cleanse',2500],['jfc','Calming Jelly Foam Cleanser','150ml','Cleanse',2200],['oil','Calming Pore Cleansing Oil','200ml','Cleanse',2600],['cap','Calming Capsule Cream','50ml','Hydrate',3200],['lot','Calming Lotion','180ml','Hydrate',2600],['pan','D-Panthenol Repair Cream Rx','30ml','Hydrate',3000],['zin','Zinc PCA Clear Cream Rx','30ml','Hydrate',3000],['pdr','Rejutox PDRN Cream Rx','30ml','Hydrate',4200],['sun','Calming Aqua Sunscreen','50ml SPF50+ PA++++','Protect',2400],['mst','Calming Soon Body Mist','150ml','Body',2200],['duo','Teca Teca Set','Serum 30ml + Gauze Pad','Sets',5800]];
  P.forEach((p, i) => db.prepare('INSERT INTO products(id,name,size,category,price,stock,sort) VALUES(?,?,?,?,?,?,?)').run(...p, 50, i)); // PLACEHOLDER prices and stock: edit in admin
}

// ---------- helpers ----------
class HttpError extends Error { constructor(c, m) { super(m); this.c = c; } }
const bad = (m, c = 400) => { throw new HttpError(c, m); };
const now = () => Math.floor(Date.now() / 1000), sha = s => crypto.createHash('sha256').update(s).digest('hex');
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const hash = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const DUMMY = hash('dummy-password');
const check = (pw, st) => { const [s, h] = st.split(':'), c = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(c, Buffer.from(h, 'hex')); };
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a || '')), Buffer.from(sha(b || '')));
const str = (v, min, max, f) => { if (typeof v !== 'string') bad(`${f} is required`); v = v.trim(); if (v.length < min || v.length > max) bad(`${f} must be ${min}-${max} characters`); return v; };
const email = v => { v = str(v, 5, 120, 'Email').toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad('Enter a valid email'); return v; };
const pass = v => { if (typeof v !== 'string' || v.length < 8 || v.length > 200) bad('Password must be at least 8 characters'); return v; };
const phone = v => { let p = String(v || '').replace(/[\s()-]/g, ''); if (/^\+?254/.test(p)) p = p.replace(/^\+/, ''); else if (/^0[17]/.test(p)) p = '254' + p.slice(1); if (!/^254[17]\d{8}$/.test(p)) bad('Enter a valid Kenyan M-Pesa number, like 0712 345 678'); return p; };
const cookies = r => Object.fromEntries((r.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const setCookie = (res, n, v, age) => { const c = `${n}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${PROD ? '; Secure' : ''}`; const p = res.getHeader('Set-Cookie') || []; res.setHeader('Set-Cookie', [].concat(p, c)); };
const hits = new Map();
const limit = (ip, key, max) => { const k = key + ':' + ip, t = Date.now(), h = hits.get(k); if (!h || t - h.t > 60000) { hits.set(k, { n: 1, t }); return; } if (++h.n > max) bad('Too many attempts. Try again in a minute.', 429); };
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.t > 60000) hits.delete(k); db.prepare('DELETE FROM sessions WHERE exp<?').run(now()); }, 60000).unref();
const login = (res, kind, uid) => { const t = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(t + SECRET), kind, uid, now() + 7 * 86400); setCookie(res, 'tt_s', t, 7 * 86400); };
const sessionOf = req => { const t = cookies(req).tt_s; if (!t) return null; return db.prepare('SELECT kind,uid FROM sessions WHERE h=? AND exp>?').get(sha(t + SECRET), now()) || null; };

// ---------- M-Pesa (Daraja) ----------
const MP = E('MPESA_ENV') === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
let tok = { v: '', exp: 0 };
async function mpToken() {
  if (tok.exp > Date.now()) return tok.v;
  const r = await fetch(MP + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + Buffer.from(E('MPESA_KEY') + ':' + E('MPESA_SECRET')).toString('base64') }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Daraja auth failed: ' + r.status);
  const j = await r.json(); tok = { v: j.access_token, exp: Date.now() + (+j.expires_in - 60) * 1000 }; return tok.v;
}
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);
async function daraja(pathname, body) {
  const ts = stamp(), r = await fetch(MP + pathname, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + await mpToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: E('MPESA_SHORTCODE'), Password: Buffer.from(E('MPESA_SHORTCODE') + E('MPESA_PASSKEY') + ts).toString('base64'), Timestamp: ts, ...body }) });
  return r.json();
}
async function stkPush(orderId, ph, amount) {
  if (MOCK) { const id = 'mock_' + crypto.randomBytes(8).toString('hex'); setTimeout(() => settle(id, 0, amount, 'MOCK' + orderId), 3000).unref(); return id; }
  const j = await daraja('/mpesa/stkpush/v1/processrequest', { TransactionType: 'CustomerPayBillOnline', Amount: amount, PartyA: ph, PartyB: E('MPESA_SHORTCODE'), PhoneNumber: ph, CallBackURL: `${BASE}/api/mpesa/callback/${CB}`, AccountReference: 'TT' + orderId, TransactionDesc: 'Tecateca order' });
  if (j.ResponseCode !== '0' || !j.CheckoutRequestID) throw new Error(j.errorMessage || j.ResponseDescription || 'STK push rejected');
  return j.CheckoutRequestID;
}
// Idempotent: safe to call from the callback, the status poll and the mock timer.
function settle(checkoutId, code, amount, receipt) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE checkout_id=?').get(checkoutId);
    if (!p || p.status !== 'pending') return false;
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id), its = db.prepare('SELECT * FROM items WHERE order_id=?').all(o.id);
    if (code !== 0) { db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(p.id); if (o.status === 'pending') { db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(o.id); its.forEach(i => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id)); } return true; }
    if (+amount !== p.amount) { db.prepare("UPDATE payments SET status='mismatch',receipt=? WHERE id=?").run(receipt || null, p.id); db.prepare("UPDATE orders SET status='review' WHERE id=?").run(o.id); return true; }
    db.prepare("UPDATE payments SET status='paid',receipt=? WHERE id=?").run(receipt || null, p.id);
    if (o.status === 'expired') its.forEach(i => db.prepare('UPDATE products SET stock=MAX(stock-?,0) WHERE id=?').run(i.qty, i.product_id));
    db.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id=?").run(now(), o.id);
    const pr = o.ref && db.prepare("SELECT * FROM partners WHERE code=? AND status='approved'").get(o.ref);
    if (pr && !(o.email && o.email === pr.email)) db.prepare('INSERT OR IGNORE INTO commissions(order_id,partner_id,amount,created) VALUES(?,?,?,?)').run(o.id, pr.id, Math.round(o.subtotal * pr.rate / 100), now());
    return true;
  });
}
setInterval(() => { try { tx(() => { for (const o of db.prepare("SELECT id FROM orders WHERE status='pending' AND created<?").all(now() - 900)) { db.prepare("UPDATE orders SET status='expired' WHERE id=?").run(o.id); db.prepare('SELECT product_id,qty FROM items WHERE order_id=?').all(o.id).forEach(i => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id)); } }); } catch (e) { console.error('sweep', e.message); } }, 60000).unref();

// ---------- routes ----------
const routes = [], R = (m, p, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
const need_ = (c, kind) => { if (!c.s || c.s.kind !== kind) bad('Please sign in', 401); return c.s.uid; };
const publicProduct = 'SELECT id,name,size,category,price,descr,(stock>0) AS in_stock FROM products WHERE active=1 ORDER BY sort';
R('GET', '/healthz', () => ({ ok: true }));
R('GET', '/api/config', () => ({ delivery: DELIVERY }));
R('GET', '/api/products', () => db.prepare(publicProduct).all());
R('GET', '/api/events', () => db.prepare("SELECT id,title,date,place,note FROM events WHERE date>=date('now','-1 day') ORDER BY date").all());
R('GET', '/r/:code', c => { const p = db.prepare("SELECT id FROM partners WHERE code=? AND status='approved'").get(c.p.code.toUpperCase()); if (p) { db.prepare('INSERT INTO clicks(partner_id,ts) VALUES(?,?)').run(p.id, now()); setCookie(c.res, 'tt_ref', c.p.code.toUpperCase(), 30 * 86400); } c.res.writeHead(302, { Location: '/', ...(c.res.getHeader('Set-Cookie') ? { 'Set-Cookie': c.res.getHeader('Set-Cookie') } : {}) }); c.res.end(); return null; });
R('POST', '/api/auth/register', c => { limit(c.ip, 'auth', 10); const e = email(c.b.email), n = str(c.b.name, 2, 80, 'Name'); if (db.prepare('SELECT 1 FROM users WHERE email=?').get(e)) bad('An account with that email already exists', 409); const r = db.prepare('INSERT INTO users(email,name,pw,created) VALUES(?,?,?,?)').run(e, n, hash(pass(c.b.password)), now()); login(c.res, 'user', Number(r.lastInsertRowid)); return { name: n, email: e }; });
R('POST', '/api/auth/login', c => { limit(c.ip, 'auth', 10); const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(c.b.email || '').toLowerCase().trim()); const ok = check(String(c.b.password || ''), u ? u.pw : DUMMY); if (!u || !ok) bad('Wrong email or password', 401); login(c.res, 'user', u.id); return { name: u.name, email: u.email }; });
R('POST', '/api/auth/logout', c => { const t = cookies(c.req).tt_s; if (t) db.prepare('DELETE FROM sessions WHERE h=?').run(sha(t + SECRET)); setCookie(c.res, 'tt_s', '', 0); return { ok: true }; });
R('GET', '/api/me', c => { if (!c.s) return { kind: null }; const t = { user: 'users', partner: 'partners' }[c.s.kind]; if (!t) return { kind: 'admin' }; const u = db.prepare(`SELECT name,email FROM ${t} WHERE id=?`).get(c.s.uid); return { kind: c.s.kind, ...u }; });
R('GET', '/api/my/orders', c => { const id = need_(c, 'user'); return db.prepare('SELECT id,total,status,created FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(id); });

R('POST', '/api/orders', async c => {
  limit(c.ip, 'order', 8);
  const its = c.b.items; if (!Array.isArray(its) || !its.length || its.length > 30) bad('Your bag is empty');
  const name = str(c.b.name, 2, 80, 'Name'), ph = phone(c.b.phone), area = str(c.b.area, 2, 40, 'Delivery area'), fee = DELIVERY[area]; if (fee === undefined) bad('Choose a delivery area from the list');
  const merged = new Map(); for (const i of its) { const q = Number(i.qty); if (typeof i.id !== 'string' || !Number.isInteger(q) || q < 1 || q > 20) bad('Invalid item'); merged.set(i.id, (merged.get(i.id) || 0) + q); }
  const ref = (cookies(c.req).tt_ref || '').toUpperCase(), uid = c.s && c.s.kind === 'user' ? c.s.uid : null, em = uid ? db.prepare('SELECT email FROM users WHERE id=?').get(uid).email : (c.b.email ? email(c.b.email) : null);
  const token = crypto.randomBytes(16).toString('hex');
  const o = tx(() => {
    let sub = 0; const rows = [];
    for (const [id, q] of merged) { const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id); if (!p) bad('An item in your bag is no longer available'); if (p.stock < q) bad(`Only ${p.stock} left of ${p.name}`, 409); sub += p.price * q; rows.push([id, q, p.price]); }
    const pr = ref && db.prepare("SELECT code FROM partners WHERE code=? AND status='approved'").get(ref);
    const id = Number(db.prepare('INSERT INTO orders(user_id,email,name,phone,area,subtotal,delivery,total,ref,token,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid, em, name, ph, area, sub, fee, sub + fee, pr ? pr.code : null, token, now()).lastInsertRowid);
    for (const [pid, q, pc] of rows) { db.prepare('INSERT INTO items VALUES(?,?,?,?)').run(id, pid, q, pc); db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(q, pid); }
    return { id, total: sub + fee };
  });
  try { const cid = await stkPush(o.id, ph, o.total); db.prepare('INSERT INTO payments(order_id,checkout_id,amount,created) VALUES(?,?,?,?)').run(o.id, cid, o.total, now()); }
  catch (e) { console.error('stk', e.message); tx(() => { db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(o.id); db.prepare('SELECT product_id,qty FROM items WHERE order_id=?').all(o.id).forEach(i => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id)); }); bad('We could not start the M-Pesa prompt. Check your number and try again.', 502); }
  return { id: o.id, token, total: o.total };
});
R('GET', '/api/orders/:id/status', async c => {
  const o = db.prepare('SELECT id,status,total,token FROM orders WHERE id=?').get(+c.p.id); if (!o || !same(o.token, c.q.get('t'))) bad('Order not found', 404);
  if (o.status === 'pending' && !MOCK) { const p = db.prepare('SELECT * FROM payments WHERE order_id=?').get(o.id); if (p && now() - p.created > 20) { try { const j = await daraja('/mpesa/stkpushquery/v1/query', { CheckoutRequestID: p.checkout_id }); if (j.ResultCode !== undefined && j.ResultCode !== '' && !j.errorCode) { const code = +j.ResultCode; settle(p.checkout_id, code, code === 0 ? p.amount : 0, null); } } catch {} } }
  const r = db.prepare('SELECT id,status,total FROM orders WHERE id=?').get(o.id); return r;
});
R('POST', '/api/mpesa/callback/:secret', c => {
  if (!same(c.p.secret, CB)) bad('Not found', 404);
  const cb = c.b && c.b.Body && c.b.Body.stkCallback; if (!cb || !cb.CheckoutRequestID) return { ResultCode: 0, ResultDesc: 'Ignored' };
  const m = Object.fromEntries(((cb.CallbackMetadata || {}).Item || []).map(i => [i.Name, i.Value]));
  try { settle(cb.CheckoutRequestID, +cb.ResultCode, m.Amount, m.MpesaReceiptNumber); } catch (e) { console.error('callback', e.message); }
  return { ResultCode: 0, ResultDesc: 'Accepted' };
});

R('POST', '/api/partners/apply', c => { limit(c.ip, 'auth', 10); const e = email(c.b.email), n = str(c.b.name, 2, 80, 'Name'), pw = pass(c.b.password); if (db.prepare('SELECT 1 FROM partners WHERE email=?').get(e)) bad('That email has already applied', 409);
  const base = n.split(/\s+/)[0].replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'PARTNER'; let code; do code = base + crypto.randomInt(10, 99); while (db.prepare('SELECT 1 FROM partners WHERE code=?').get(code));
  db.prepare('INSERT INTO partners(email,name,pw,code,created) VALUES(?,?,?,?,?)').run(e, n, hash(pw), code, now()); return { ok: true }; });
R('POST', '/api/partners/login', c => { limit(c.ip, 'auth', 10); const p = db.prepare('SELECT * FROM partners WHERE email=?').get(String(c.b.email || '').toLowerCase().trim()); const ok = check(String(c.b.password || ''), p ? p.pw : DUMMY); if (!p || !ok) bad('Wrong email or password', 401); if (p.status !== 'approved') bad(p.status === 'pending' ? 'Your application is still being reviewed' : 'This account is suspended', 403); login(c.res, 'partner', p.id); return { ok: true }; });
R('GET', '/api/partners/me', c => { const id = need_(c, 'partner'), p = db.prepare('SELECT id,name,email,code,rate,mpesa FROM partners WHERE id=?').get(id);
  const s = db.prepare("SELECT COUNT(*) n,COALESCE(SUM(o.subtotal),0) sales FROM commissions k JOIN orders o ON o.id=k.order_id WHERE k.partner_id=?").get(id), a = db.prepare("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending,COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) paid FROM commissions WHERE partner_id=?").get(id);
  return { ...p, link: `${BASE}/r/${p.code}`, clicks: db.prepare('SELECT COUNT(*) n FROM clicks WHERE partner_id=?').get(id).n, orders: s.n, sales: s.sales, ...a, recent: db.prepare('SELECT o.id,o.paid_at,o.subtotal,k.amount,k.status FROM commissions k JOIN orders o ON o.id=k.order_id WHERE k.partner_id=? ORDER BY k.id DESC LIMIT 50').all(id) }; });
R('PUT', '/api/partners/me', c => { const id = need_(c, 'partner'); db.prepare('UPDATE partners SET mpesa=? WHERE id=?').run(phone(c.b.mpesa), id); return { ok: true }; });

R('POST', '/api/admin/login', c => { limit(c.ip, 'auth', 10); const ok = E('ADMIN_EMAIL') && E('ADMIN_PASSWORD') && same(String(c.b.email || '').toLowerCase(), E('ADMIN_EMAIL').toLowerCase()) & same(String(c.b.password || ''), E('ADMIN_PASSWORD')); if (!ok) bad('Wrong email or password', 401); login(c.res, 'admin', 0); return { ok: true }; });
R('GET', '/api/admin/summary', c => { need_(c, 'admin'); return { orders: db.prepare('SELECT id,name,phone,area,total,status,ref,created FROM orders ORDER BY id DESC LIMIT 200').all(), partners: db.prepare('SELECT id,name,email,code,status,rate,mpesa FROM partners ORDER BY id DESC').all(), commissions: db.prepare('SELECT k.id,k.order_id,k.amount,k.status,p.name partner,p.mpesa FROM commissions k JOIN partners p ON p.id=k.partner_id ORDER BY k.id DESC LIMIT 200').all(), products: db.prepare('SELECT id,name,price,stock,active FROM products ORDER BY sort').all(), events: db.prepare('SELECT * FROM events ORDER BY date').all() }; });
R('POST', '/api/admin/events', c => { need_(c, 'admin'); const d = str(c.b.date, 10, 10, 'Date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) bad('Date must be YYYY-MM-DD'); const r = db.prepare('INSERT INTO events(title,date,place,note) VALUES(?,?,?,?)').run(str(c.b.title, 2, 120, 'Title'), d, String(c.b.place || '').slice(0, 120), String(c.b.note || '').slice(0, 300)); return { id: Number(r.lastInsertRowid) }; });
R('DELETE', '/api/admin/events/:id', c => { need_(c, 'admin'); db.prepare('DELETE FROM events WHERE id=?').run(+c.p.id); return { ok: true }; });
R('PUT', '/api/admin/partners/:id', c => { need_(c, 'admin'); const p = db.prepare('SELECT id FROM partners WHERE id=?').get(+c.p.id); if (!p) bad('Partner not found', 404); if (c.b.status !== undefined) { if (!['pending', 'approved', 'suspended'].includes(c.b.status)) bad('Invalid status'); db.prepare('UPDATE partners SET status=? WHERE id=?').run(c.b.status, p.id); } if (c.b.rate !== undefined) { const r = Number(c.b.rate); if (!(r >= 0 && r <= 50)) bad('Rate must be 0-50'); db.prepare('UPDATE partners SET rate=? WHERE id=?').run(r, p.id); } return { ok: true }; });
R('POST', '/api/admin/commissions/:id/pay', c => { need_(c, 'admin'); const r = db.prepare("UPDATE commissions SET status='paid',paid_at=? WHERE id=? AND status='pending'").run(now(), +c.p.id); if (!r.changes) bad('Commission not found or already paid', 404); return { ok: true }; });
R('PUT', '/api/admin/products/:id', c => { need_(c, 'admin'); const p = db.prepare('SELECT * FROM products WHERE id=?').get(c.p.id); if (!p) bad('Product not found', 404); const pr = c.b.price ?? p.price, st = c.b.stock ?? p.stock, ac = c.b.active ?? p.active; if (!Number.isInteger(pr) || pr < 0 || !Number.isInteger(st) || st < 0) bad('Price and stock must be whole numbers'); db.prepare('UPDATE products SET price=?,stock=?,active=? WHERE id=?').run(pr, st, ac ? 1 : 0, p.id); return { ok: true }; });

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }, PUB = path.resolve('public');
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
  if (E('NOINDEX') === '1') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x'), ip = (E('TRUST_PROXY') === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  const send = (code, obj) => { if (res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const hit = routes.map(r => ({ r, m: r.m === req.method && url.pathname.match(r.re) })).find(x => x.m);
    if (hit) {
      const isCb = url.pathname.startsWith('/api/mpesa/callback/'); let b = {};
      if (req.method !== 'GET') {
        if (!isCb) { if (!(req.headers['content-type'] || '').startsWith('application/json') && req.method !== 'DELETE') bad('Content-Type must be application/json', 415); const o = req.headers.origin; if (o && o !== new URL(BASE).origin && o !== `http://${req.headers.host}`) bad('Cross-site request blocked', 403); }
        let n = 0; const chunks = []; for await (const ch of req) { n += ch.length; if (n > 100000) bad('Request too large', 413); chunks.push(ch); }
        if (chunks.length) try { b = JSON.parse(Buffer.concat(chunks)); } catch { bad('Invalid JSON'); }
      }
      const out = await hit.r.fn({ req, res, ip, b: b && typeof b === 'object' ? b : {}, p: hit.m.groups || {}, q: url.searchParams, s: sessionOf(req) });
      return out === null ? undefined : send(200, out);
    }
    if (url.pathname.startsWith('/api/')) bad('Not found', 404);
    let f = path.resolve(PUB, '.' + decodeURIComponent(url.pathname)); if (!f.startsWith(PUB + path.sep) && f !== PUB) bad('Not found', 404);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=86400' }); fs.createReadStream(f).pipe(res);
  } catch (e) { if (e instanceof HttpError) return send(e.c, { error: e.message }); console.error(e); send(500, { error: 'Something went wrong on our side' }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`Tecateca Kenya on ${BASE} (M-Pesa ${MOCK ? 'MOCK' : 'LIVE ' + E('MPESA_ENV')})`));
module.exports = server;
process.on('SIGTERM', () => server.close(() => process.exit(0)));

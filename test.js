'use strict';
// End-to-end test: starts the server in mock M-Pesa mode on a temp DB and walks the real flows.
const { spawn } = require('node:child_process'), assert = require('node:assert/strict'), fs = require('node:fs');
const PORT = 3999, B = `http://localhost:${PORT}`, DB = '/tmp/tt-test.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) try { fs.unlinkSync(f); } catch {}
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: DB, MPESA_MOCK: '1', ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'a-long-passphrase', SESSION_SECRET: 's', BASE_URL: B, NODE_ENV: '' }, stdio: 'ignore' });
const client = () => { const jar = {}; return async (m, p, body, h = {}) => { const r = await fetch(B + p, { method: m, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...h }, body: body ? JSON.stringify(body) : undefined }); for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'), [k, v] = kv.split('='); if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v; } const t = await r.text(); let j; try { j = JSON.parse(t); } catch {} return { s: r.status, j, h: r.headers }; }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = async (name, fn) => { try { await fn(); console.log('  ok  ' + name); n++; } catch (e) { console.log('FAIL  ' + name + '\n' + e.message); process.exitCode = 1; } };
(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(100); }
  const admin = client(), partner = client(), shopper = client(), guest = client();
  await ok('serves the store page and products', async () => { assert.equal((await guest('GET', '/')).s, 200); const r = await guest('GET', '/api/products'); assert.equal(r.j.length, 15); assert.equal(r.j[0].in_stock, 1); });
  await ok('rejects bad admin login, accepts good one', async () => { assert.equal((await admin('POST', '/api/admin/login', { email: 'boss@x.com', password: 'nope' })).s, 401); assert.equal((await admin('POST', '/api/admin/login', { email: 'boss@x.com', password: 'a-long-passphrase' })).s, 200); });
  await ok('admin routes need admin', async () => assert.equal((await guest('GET', '/api/admin/summary')).s, 401));
  await ok('partner applies, cannot sign in until approved', async () => {
    assert.equal((await partner('POST', '/api/partners/apply', { name: 'Amina Wanjiru', email: 'Amina@x.com', password: 'password1' })).s, 200);
    assert.equal((await partner('POST', '/api/partners/apply', { name: 'Amina Wanjiru', email: 'amina@x.com', password: 'password1' })).s, 409);
    assert.equal((await partner('POST', '/api/partners/login', { email: 'amina@x.com', password: 'password1' })).s, 403); });
  let pid, code;
  await ok('admin approves partner and sets 12% rate', async () => { const s = (await admin('GET', '/api/admin/summary')).j; pid = s.partners[0].id; code = s.partners[0].code; assert.equal((await admin('PUT', '/api/admin/partners/' + pid, { status: 'approved', rate: 12 })).s, 200); assert.equal((await partner('POST', '/api/partners/login', { email: 'amina@x.com', password: 'password1' })).s, 200); });
  await ok('referral link sets cookie and counts a click', async () => { const r = await shopper('GET', '/r/' + code); assert.equal(r.s, 302); assert.equal((await partner('GET', '/api/partners/me')).j.clicks, 1); });
  let order;
  await ok('order totals are computed server-side; client price ignored', async () => {
    const r = await shopper('POST', '/api/orders', { items: [{ id: 'ser', qty: 2, price: 1 }, { id: 'pad', qty: 1 }], name: 'Wanjiku M', phone: '0712 345 678', area: 'Nairobi', email: 'w@x.com' });
    assert.equal(r.s, 200, JSON.stringify(r.j)); order = r.j; assert.equal(order.total, 3400 * 2 + 2800 + 250); });
  await ok('stock reserved at checkout', async () => assert.equal((await admin('GET', '/api/admin/summary')).j.products.find(p => p.id === 'ser').stock, 48));
  await ok('order is pending, then paid after the M-Pesa callback', async () => {
    assert.equal((await shopper('GET', `/api/orders/${order.id}/status?t=${order.token}`)).j.status, 'pending');
    for (let i = 0; i < 40; i++) { await sleep(250); if ((await shopper('GET', `/api/orders/${order.id}/status?t=${order.token}`)).j.status === 'paid') break; }
    assert.equal((await shopper('GET', `/api/orders/${order.id}/status?t=${order.token}`)).j.status, 'paid'); });
  await ok('status needs the right token', async () => assert.equal((await guest('GET', `/api/orders/${order.id}/status?t=wrong`)).s, 404));
  await ok('partner earns 12% of the product subtotal (not delivery), once', async () => { const me = (await partner('GET', '/api/partners/me')).j; assert.equal(me.orders, 1); assert.equal(me.pending, Math.round(9600 * 0.12)); assert.equal(me.sales, 9600); });
  await ok('real Daraja-style callback is idempotent and checks amount', async () => {
    const cid = 'mock_replay'; const body = { Body: { stkCallback: { CheckoutRequestID: cid, ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }] } } } };
    assert.equal((await guest('POST', '/api/mpesa/callback/wrong', body)).s, 404);
    assert.equal((await guest('POST', '/api/mpesa/callback/dev-callback', body)).j.ResultCode, 0);
    assert.equal((await partner('GET', '/api/partners/me')).j.orders, 1); });
  await ok('admin marks commission paid once', async () => { const c = (await admin('GET', '/api/admin/summary')).j.commissions[0]; assert.equal((await admin('POST', `/api/admin/commissions/${c.id}/pay`, {})).s, 200); assert.equal((await admin('POST', `/api/admin/commissions/${c.id}/pay`, {})).s, 404); assert.equal((await partner('GET', '/api/partners/me')).j.paid, 1152); });
  await ok('overselling blocked, bad input rejected', async () => {
    assert.equal((await guest('POST', '/api/orders', { items: [{ id: 'ser', qty: 20 }, { id: 'ser', qty: 20 }, { id: 'ser', qty: 20 }], name: 'Bob K', phone: '0712345678', area: 'Nairobi' })).s, 409);
    assert.equal((await guest('POST', '/api/orders', { items: [{ id: 'ser', qty: 1 }], name: 'Bob K', phone: '12345', area: 'Nairobi' })).s, 400);
    assert.equal((await guest('POST', '/api/orders', { items: [{ id: 'ser', qty: -1 }], name: 'Bob K', phone: '0712345678', area: 'Nairobi' })).s, 400);
    assert.equal((await guest('POST', '/api/orders', { items: [{ id: 'nope', qty: 1 }], name: 'Bob K', phone: '0712345678', area: 'Nairobi' })).s, 400);
    assert.equal((await guest('POST', '/api/orders', { items: [{ id: 'ser', qty: 1 }], name: 'Bob K', phone: '0712345678', area: 'Mars' })).s, 400); });
  await ok('partners cannot earn on their own orders', async () => { await partner('GET', '/r/' + code); const r = await partner('POST', '/api/orders', { items: [{ id: 'lot', qty: 1 }], name: 'Amina W', phone: '0722000111', area: 'Kiambu', email: 'amina@x.com' }); assert.equal(r.s, 200); await sleep(3600); assert.equal((await partner('GET', `/api/orders/${r.j.id}/status?t=${r.j.token}`)).j.status, 'paid'); assert.equal((await partner('GET', '/api/partners/me')).j.orders, 1); });
  await ok('customer register, login, orders list, logout', async () => { assert.equal((await shopper('POST', '/api/auth/register', { name: 'Wanjiku M', email: 'w@x.com', password: 'longenough1' })).s, 200); assert.equal((await shopper('GET', '/api/me')).j.kind, 'user'); await shopper('POST', '/api/auth/logout', {}); assert.equal((await shopper('GET', '/api/me')).j.kind, null); assert.equal((await shopper('POST', '/api/auth/login', { email: 'w@x.com', password: 'wrong' })).s, 401); assert.equal((await shopper('POST', '/api/auth/login', { email: 'w@x.com', password: 'longenough1' })).s, 200); });
  await ok('admin events show on the public site; past events hidden', async () => { await admin('POST', '/api/admin/events', { title: 'Pop-up', date: '2099-01-01', place: 'Westgate' }); await admin('POST', '/api/admin/events', { title: 'Old', date: '2001-01-01' }); const e = (await guest('GET', '/api/events')).j; assert.equal(e.length, 1); assert.equal(e[0].title, 'Pop-up'); });
  await ok('security: JSON-only, path traversal, rate limit', async () => { assert.equal((await guest('POST', '/api/auth/login', null, { 'Content-Type': 'text/plain' })).s, 415); assert.equal((await guest('GET', '/..%2f..%2fserver.js')).s, 404); let last; for (let i = 0; i < 12; i++) last = await guest('POST', '/api/auth/login', { email: 'x@x.com', password: 'y' }); assert.equal(last.s, 429); });
  console.log(`\n${n} checks passed${process.exitCode ? ', with failures' : ''}`); srv.kill();
})();

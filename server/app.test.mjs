import test from 'node:test';
import assert from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createApp } from './index.mjs';
import { mockProvider } from './providers.mjs';

const PGBIN = process.env.PGBIN || '/usr/lib/postgresql/16/bin';
let dir, pool, server, base, ok = true;
const run = (c) => process.getuid() === 0 ? `runuser -u postgres -- ${c}` : c;

test.before(async () => {
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naru-pg-')); fs.chmodSync(dir, 0o755); if (process.getuid() === 0) execSync('chown postgres ' + dir);
    execSync(run(`${PGBIN}/initdb -D ${dir}/d -A trust`), { stdio: 'ignore' });
    execSync(run(`${PGBIN}/pg_ctl -D ${dir}/d -o "-p 54396 -k ${dir}" -l ${dir}/log -w start`), { stdio: 'ignore' });
    execSync(run(`psql -h ${dir} -p 54396 -U postgres -q -c "create database t"`) + ' postgres', { stdio: 'ignore' });
    execSync(run(`psql -h ${dir} -p 54396 -U postgres -q -v ON_ERROR_STOP=1 -f ${path.resolve('server/schema.sql')} t`), { stdio: 'ignore' });
    pool = new pg.Pool({ host: dir, port: 54396, user: 'postgres', database: 't' });
    server = createApp({ pool, provider: mockProvider(), opts: { longInputChars: 3000, rate: 1000, dailyLimit: 1000 } });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
  } catch (e) { ok = false; console.error('Postgres not available, skipping:', e.message); }
});
test.after(async () => { if (!ok) return; server.close(); await pool.end(); try { execSync(run(`${PGBIN}/pg_ctl -D ${dir}/d stop`), { stdio: 'ignore' }); } catch { } });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r;
  }
  async json(m, u, b) { const r = await this.req(m, u, b); return { status: r.status, body: await r.json() }; }
  async chat(body) {
    const r = await this.req('POST', '/api/chat', body); const txt = await r.text(); if (r.status !== 200) return { status: r.status, events: [], body: JSON.parse(txt) };
    return { status: 200, events: txt.split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6))) };
  }
}
const needs = t => { if (!ok) t.skip('no postgres'); return !ok; };

test('auth: signup, wrong password, login, me, logout, protected routes', async t => {
  if (needs(t)) return; const a = new Client();
  assert.equal((await a.json('GET', '/api/me')).status, 401);
  assert.equal((await a.json('POST', '/api/signup', { email: 'bad', password: 'longenough' })).status, 400);
  assert.equal((await a.json('POST', '/api/signup', { email: 'a@x.com', password: 'short' })).status, 400);
  assert.equal((await a.json('POST', '/api/signup', { email: 'a@x.com', password: 'password123' })).status, 201);
  assert.equal((await a.json('GET', '/api/me')).body.email, 'a@x.com');
  assert.equal((await new Client().json('POST', '/api/signup', { email: 'A@x.com', password: 'password123' })).status, 409);
  const b = new Client(); assert.equal((await b.json('POST', '/api/login', { email: 'a@x.com', password: 'nope-nope' })).status, 401);
  assert.equal((await b.json('POST', '/api/login', { email: 'a@x.com', password: 'password123' })).status, 200);
  await b.json('POST', '/api/logout', {}); assert.equal((await b.json('GET', '/api/me')).status, 401);
  const hash = (await pool.query("select password_hash from users where email = 'a@x.com'")).rows[0].password_hash; assert.ok(hash.startsWith('scrypt$') && !hash.includes('password123'));
});

test('chat: streams, saves, history survives, branch order, rename, search, delete', async t => {
  if (needs(t)) return; const a = new Client(); await a.json('POST', '/api/signup', { email: 'c@x.com', password: 'password123' });
  const r = await a.chat({ text: 'Hello Naru' }); assert.equal(r.status, 200);
  assert.equal(r.events[0].type, 'start'); assert.ok(r.events.some(e => e.type === 'delta')); assert.equal(r.events.at(-1).type, 'done'); assert.equal(r.events.at(-1).status, 'complete');
  const cid = r.events[0].conversationId, streamed = r.events.filter(e => e.type === 'delta').map(e => e.text).join('');
  const r2 = await a.chat({ conversationId: cid, text: 'And again' }); assert.equal(r2.events.at(-1).status, 'complete');
  const conv = (await a.json('GET', '/api/conversations/' + cid)).body;
  assert.deepEqual(conv.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']); assert.equal(conv.messages[1].text, streamed);
  assert.equal((await a.json('GET', '/api/conversations')).body.conversations.length, 1);
  assert.equal((await a.json('GET', '/api/conversations?q=Hello')).body.conversations.length, 1);
  assert.equal((await a.json('GET', '/api/conversations?q=zzzz')).body.conversations.length, 0);
  assert.equal((await a.json('PATCH', '/api/conversations/' + cid, { title: 'Renamed' })).status, 200);
  assert.equal((await a.json('DELETE', '/api/conversations/' + cid)).status, 200);
  assert.equal((await a.json('GET', '/api/conversations/' + cid)).status, 404);
});

test('isolation: a second user cannot read, write to, rename or delete the first users chat', async t => {
  if (needs(t)) return; const a = new Client(), b = new Client();
  await a.json('POST', '/api/signup', { email: 'i1@x.com', password: 'password123' }); await b.json('POST', '/api/signup', { email: 'i2@x.com', password: 'password123' });
  const cid = (await a.chat({ text: 'secret plans' })).events[0].conversationId;
  assert.equal((await b.json('GET', '/api/conversations/' + cid)).status, 404);
  assert.equal((await b.json('PATCH', '/api/conversations/' + cid, { title: 'x' })).status, 404);
  assert.equal((await b.json('DELETE', '/api/conversations/' + cid)).status, 404);
  assert.equal((await b.chat({ conversationId: cid, text: 'hi' })).status, 404);
  assert.equal((await b.json('GET', '/api/conversations?q=secret')).body.conversations.length, 0);
});

test('long prompt: a big document is read in batches with progress, never sent whole', async t => {
  if (needs(t)) return; const a = new Client(); await a.json('POST', '/api/signup', { email: 'l1@x.com', password: 'password123' });
  const doc = Array.from({ length: 40 }, (_, i) => (i === 25 ? 'NARU-FACT the vault code is 42. ' : '') + 'filler text '.repeat(150)).join('\n\n');
  const r = await a.chat({ text: doc + '\n\nWhat is the vault code?' });
  const prog = r.events.filter(e => e.type === 'progress' && e.stage === 'read'); assert.ok(prog.length >= 5, 'batches: ' + prog.length);
  assert.match(r.events.filter(e => e.type === 'delta').map(e => e.text).join(''), /vault code is 42/); assert.equal(r.events.at(-1).status, 'complete');
  const job = (await pool.query("select * from jobs where kind = 'long_input' order by created_at desc limit 1")).rows[0]; assert.equal(job.status, 'done');
});

test('long answer: one section per batch, saved job, resumable', async t => {
  if (needs(t)) return; const a = new Client(); await a.json('POST', '/api/signup', { email: 'w1@x.com', password: 'password123' });
  const r = await a.chat({ text: 'Write a detailed guide about tea', sections: 3 });
  const deltas = r.events.filter(e => e.type === 'delta'); assert.equal(deltas.length, 3); assert.match(deltas[0].text, /## Background/); assert.equal(r.events.at(-1).status, 'complete');
  const jobId = r.events.at(-1).jobId; const job = (await pool.query('select * from jobs where id = $1', [jobId])).rows[0]; assert.equal(job.done_steps, 3); assert.equal(job.state.sections.length, 3);
  await pool.query("update jobs set state = $1, status = 'cancelled' where id = $2", [JSON.stringify({ sections: job.state.sections.slice(0, 1) }), jobId]);
  const r2 = await a.chat({ text: 'Write a detailed guide about tea', sections: 3, resumeJobId: jobId }); assert.equal(r2.events.filter(e => e.type === 'delta').length, 2);
});

test('limits and validation: empty, too long, rate limit', async t => {
  if (needs(t)) return; const a = new Client(); await a.json('POST', '/api/signup', { email: 'v1@x.com', password: 'password123' });
  assert.equal((await a.chat({ text: '   ' })).status, 400); assert.equal((await a.chat({ text: 'x'.repeat(200001) })).status, 413);
  const s2 = createApp({ pool, provider: mockProvider(), opts: { rate: 2, dailyLimit: 1000 } }); await new Promise(r => s2.listen(0, '127.0.0.1', r)); const saved = base; base = 'http://127.0.0.1:' + s2.address().port;
  const b = new Client(); await b.json('POST', '/api/login', { email: 'v1@x.com', password: 'password123' });
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await b.chat({ text: 'hi ' + i })).status); base = saved; s2.close();
  assert.deepEqual(codes, [200, 200, 429, 429]);
});

test('stop: aborting mid-reply keeps what was written and marks it stopped', async t => {
  if (needs(t)) return;
  const s2 = createApp({ pool, provider: mockProvider({ delay: 60 }), opts: { rate: 1000, dailyLimit: 1000 } }); await new Promise(r => s2.listen(0, '127.0.0.1', r)); const saved = base; base = 'http://127.0.0.1:' + s2.address().port;
  const a = new Client(); await a.json('POST', '/api/signup', { email: 's1@x.com', password: 'password123' });
  const ac = new AbortController(); const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie }, body: JSON.stringify({ text: 'tell me something long please' }), signal: ac.signal });
  const reader = r.body.getReader(); let seen = ''; while (!/delta/.test(seen)) { const { value } = await reader.read(); seen += new TextDecoder().decode(value); }
  ac.abort(); await new Promise(r => setTimeout(r, 400));
  const row = (await pool.query("select status, content from messages where role = 'assistant' and user_id = (select id from users where email = 's1@x.com')")).rows[0];
  base = saved; s2.close();
  assert.equal(row.status, 'stopped'); assert.ok(row.content[0].text.length > 0);
});

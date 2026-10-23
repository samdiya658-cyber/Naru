import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (!process.env.VERCEL) {
  try { process.loadEnvFile?.(); } catch {}
  try { process.loadEnvFile?.(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env')); } catch {}
  try { process.loadEnvFile?.(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')); } catch {}
}
import pg from 'pg';
import { hashPassword, verifyPassword, newToken, tokenHash, parseCookies } from './auth.mjs';
import { providerFromEnv } from './providers.mjs';
import { chunkText, answerLongInput, writeLongAnswer } from './longtext.mjs';

const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.resolve('uploads');
try { if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}

const SYSTEM = `You are Naru, an intelligent AI coworker. You think carefully, solve complex tasks on behalf of the user, write robust code, build interactive web applications, create vector graphics, analyze data, and produce high-quality deliverables.
When working on multi-step tasks or building apps, you can outline your execution steps at the beginning using:
<coworkPlan>
[✓] Step 1 done
[▶] Step 2 in progress
[ ] Step 3 next
</coworkPlan>
When creating interactive apps, games, tools, components, SVG graphics, or comprehensive documents, provide them in a clean code block with the language and title (for example: \`\`\`html title="Interactive App" or \`\`\`svg title="Vector Graphic") so they automatically render in the interactive artifact workspace.
Always ensure HTML apps are self-contained with styles and scripts included so they work seamlessly in the live preview.
Do NOT output HTML or JavaScript canvas scripts when asked for images or photos; image generation is handled directly.`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const LONG_ANSWER_RE = /\b(\d{3,5}[- ]?words?|essay|full report|detailed (guide|article|report)|step[- ]by[- ]step guide|long answer)\b/i;

export function createHandler({ pool, provider = providerFromEnv(), dist = null, opts = {} }) {
  const o = { longInputChars: 12000, maxText: 200000, dailyLimit: 200, rate: 30, secure: false, historyChars: 24000, ...opts };
  const hits = new Map();
  const limited = uid => { const now = Date.now(), a = (hits.get(uid) ?? []).filter(t => now - t < 60000); a.push(now); hits.set(uid, a); return a.length > o.rate; };
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
  const readJson = (req, max = 1_000_000) => new Promise((ok, no) => {
    if (req.body && typeof req.body === 'object') return ok(req.body);
    if (typeof req.body === 'string') {
      try { return ok(JSON.parse(req.body)); } catch { return no(new Error('bad json')); }
    }
    let b = ''; req.on('data', c => { b += c; if (b.length > max) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('bad json')); } });
  });
  const cookie = (t, max) => 'naru_session=' + t + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + max + (o.secure ? '; Secure' : '');
  async function userOf(req) {
    const t = parseCookies(req.headers.cookie).naru_session; if (!t) return null;
    const r = await pool.query('select u.id, u.email, p.display_name from sessions s join users u on u.id = s.user_id join profiles p on p.id = u.id where s.token_hash = $1 and s.expires_at > now()', [tokenHash(t)]);
    return r.rows[0] ?? null;
  }
  async function startSession(res, uid, body, code = 200) {
    const t = newToken(); await pool.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '30 days')", [tokenHash(t), uid]);
    send(res, code, body, { 'set-cookie': cookie(t, 2592000) });
  }
  // The branch shown: from active_leaf up through parent_id. Every query here filters by the signed-in user.
  async function branch(uid, cid) {
    const r = await pool.query(`with recursive b as (
        select m.* from messages m join conversations c on c.active_leaf = m.id where c.id = $1 and c.user_id = $2
        union all select m.* from messages m join b on m.id = b.parent_id)
      select id, parent_id, role, content, status, created_at from b order by created_at, id`, [cid, uid]);
    return r.rows;
  }
  const textOf = m => (m.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('');
  const attachmentsOf = m => (m.content ?? []).filter(x => x.type === 'attachment').map(x => ({ id: x.id, name: x.name, url: x.url || ('/api/attachments/' + x.id), mime: x.mime, size: x.size }));

  async function chat(req, res, user) {
    try {
      const body = await readJson(req); const text = String(body.text ?? '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text && attachments.length === 0) return send(res, 400, { error: 'Type a message or attach an image.' });
      if (text.length > o.maxText) return send(res, 413, { error: 'That message is too long (limit ' + o.maxText + ' characters).' });
      if (limited(user.id)) return send(res, 429, { error: 'Slow down a little. Try again in a minute.' });
      const used = (await pool.query("select count(*)::int n from messages where user_id = $1 and role = 'user' and created_at > now() - interval '24 hours'", [user.id])).rows[0].n;
      if (used >= o.dailyLimit) return send(res, 429, { error: 'Daily limit reached. It resets as older messages pass 24 hours.' });
      let cid = body.conversationId;
    const titleText = text || (attachments[0]?.name ? 'Image: ' + attachments[0].name : 'New chat');
    if (cid) { const c = await pool.query('select id from conversations where id = $1 and user_id = $2', [cid, user.id]); if (!c.rows[0]) return send(res, 404, { error: 'Chat not found.' }); }
    else cid = (await pool.query('insert into conversations (user_id, title) values ($1, $2) returning id', [user.id, titleText.replace(/\s+/g, ' ').slice(0, 60)])).rows[0].id;
    const prior = await branch(user.id, cid), parent = prior.at(-1)?.id ?? null;

    const userContent = [];
    if (text) userContent.push({ type: 'text', text });
    for (const a of attachments) {
      userContent.push({ type: 'attachment', id: a.id, name: a.name, url: a.url || ('/api/attachments/' + a.id), mime: a.mime, size: a.size });
    }
    const um = (await pool.query("insert into messages (conversation_id, user_id, parent_id, role, content) values ($1,$2,$3,'user',$4) returning id", [cid, user.id, parent, JSON.stringify(userContent)])).rows[0].id;
    if (attachments.length > 0) {
      const ids = attachments.map(a => a.id).filter(Boolean);
      if (ids.length > 0) {
        await pool.query('update attachments set message_id = $1 where id = any($2) and user_id = $3', [um, ids, user.id]).catch(() => {});
      }
    }

    const am = (await pool.query("insert into messages (conversation_id, user_id, parent_id, role, content, status) values ($1,$2,$3,'assistant','[]','streaming') returning id", [cid, user.id, um])).rows[0].id;
    await pool.query('update conversations set active_leaf = $1, updated_at = now() where id = $2', [am, cid]);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ev = obj => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    ev({ type: 'start', conversationId: cid, messageId: am, userMessageId: um });

    // Handle Image Generation requests
    const cleanText = text.replace(/^[\p{Emoji}\s]+/u, '').trim();
    const isExplicitCodeRequest = /\b(svg|vector code|html canvas|canvas code|source code)\b/i.test(text) && !/(\/image|\/imagine)/i.test(text);
    const isImageGen = !isExplicitCodeRequest && (
      body.mode === 'image'
      || /^\s*(\/image|\/imagine)\b/i.test(text)
      || /^\s*(\/image|\/imagine)\b/i.test(cleanText)
      || /\b(\/image|\/imagine)\b/i.test(text)
      || /\b(generate|create|draw|paint|render|make|show me)\s+(an?\s+)?(image|picture|photo|artwork)\b/i.test(text)
      || /\b(generate|create|draw|paint|render|make|show me)\s+(an?\s+)?(image|picture|photo|artwork)\b/i.test(cleanText)
    );

    if (isImageGen) {
      let promptText = text
        .replace(/^[\p{Emoji}\s]+/u, '') // remove leading emojis (e.g. 🎨)
        .replace(/^(\/image|\/imagine)\s*/i, '') // remove /image or /imagine
        .replace(/\b(\/image|\/imagine)\s*/i, '')
        .replace(/^.*?\b(generate|create|draw|paint|render|make|show me)\s+(an?\s+)?(image|picture|photo|artwork)\s+(of\s+)?/i, '')
        .replace(/^(an?|the)\s+/i, '')
        .trim();

      if (!promptText) promptText = cleanText || text || 'a creative digital artwork';
      const seed = Math.floor(Math.random() * 10000000);
      const pollKey = (process.env.POLLINATIONS_API_KEY || process.env.POLLEN_API_KEY || '').trim();
      const apiUrl = pollKey
        ? `https://gen.pollinations.ai/image/${encodeURIComponent(promptText)}?width=1024&height=1024&nologo=true&seed=${seed}&key=${encodeURIComponent(pollKey)}`
        : `https://image.pollinations.ai/prompt/${encodeURIComponent(promptText)}?nologo=true&seed=${seed}`;

      ev({ type: 'delta', text: '🎨 Generating image with AI, please wait a moment...\n\n' });

      let outText = '';
      try {
        const fetchRes = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
        const contentType = fetchRes.headers.get('content-type') || '';

        if (fetchRes.ok && contentType.includes('image')) {
          const arrayBuf = await fetchRes.arrayBuffer();
          const base64Data = Buffer.from(arrayBuf).toString('base64');
          const dataUrl = `data:${contentType.split(';')[0]};base64,${base64Data}`;
          outText = `Here is your generated image for **${promptText}**:\n\n![${promptText.replace(/[[\]]/g, '')}](${dataUrl})\n\n*(Generated via Pollinations AI)*`;
        } else {
          const errBody = await fetchRes.text().catch(() => '');
          let msg = 'The free image cluster is currently in a 45-second cooldown per IP.';
          try {
            const parsed = JSON.parse(errBody);
            if (parsed?.error?.message) msg = parsed.error.message;
          } catch {}
          outText = `⚠️ **Image Generation Notice**\n\n${msg}\n\n- ⏳ Please wait ~30 seconds and try again.\n- 🔑 **For unlimited instant generation**: Get a free API key at [enter.pollinations.ai/keys](https://enter.pollinations.ai/keys) and add \`POLLINATIONS_API_KEY\` to your Vercel Environment Variables.`;
        }
      } catch (err) {
        outText = `⚠️ **Image Generation Notice**\n\nThe image provider took too long to respond. Please try again with a slightly simpler prompt, or add a free \`POLLINATIONS_API_KEY\` from [enter.pollinations.ai/keys](https://enter.pollinations.ai/keys) to bypass limits.`;
      }

      ev({ type: 'delta', text: outText, replace: true });
      await pool.query('update messages set content = $1, status = $2, stop_reason = $3 where id = $4', [JSON.stringify([{ type: 'text', text: outText }]), 'complete', 'end', am]).catch(e => console.error(e.message));
      ev({ type: 'done', status: 'complete', jobId: null });
      return res.end();
    }

    const ac = new AbortController(); let finished = false;
    let jobChain = Promise.resolve(); const jobWrite = (sql, args) => { jobChain = jobChain.then(() => pool.query(sql, args)).catch(() => { }); };   // job rows are written in order
    res.on('close', () => { if (!finished) ac.abort(); });
    let out = '', status = 'complete', stop = 'end', jobId = null;
    try {
      // history trimmed from the oldest end to a character budget
      let hist = prior.filter(m => m.status !== 'error').map(m => ({ role: m.role, content: textOf(m) })).filter(m => m.content);
      let size = 0; const keep = []; for (const m of hist.reverse()) { size += m.content.length; if (size > o.historyChars) break; keep.unshift(m); } hist = keep;
      const wantLongAnswer = body.long === 'answer' || (body.long !== 'off' && LONG_ANSWER_RE.test(text) && text.length < o.longInputChars);
      if (text.length > o.longInputChars) {
        // LONG PROMPT: read in batches, answer from notes
        const paras = text.split(/\n{2,}/), last = paras.at(-1) ?? '';
        const question = paras.length > 1 && last.length < 600 ? last : 'Summarize this text.', document = paras.length > 1 && last.length < 600 ? paras.slice(0, -1).join('\n\n') : text;
        const total = chunkText(document, 1500, 100).length;
        jobId = (await pool.query("insert into jobs (user_id, conversation_id, kind, status, total_steps) values ($1,$2,'long_input','running',$3) returning id", [user.id, cid, total + 1])).rows[0].id;
        const r = await answerLongInput(provider, { question, document, signal: ac.signal, onProgress: p => { ev({ type: 'progress', ...p }); jobWrite('update jobs set done_steps = $1, updated_at = now() where id = $2', [p.done, jobId]); } });
        out = r.answer; ev({ type: 'delta', text: out });
      } else if (wantLongAnswer) {
        // LONG ANSWER: outline, then one section per batch; sections stream as they finish
        let resume = [];
        if (body.resumeJobId) { const j = await pool.query("select id, state from jobs where id = $1 and user_id = $2 and kind = 'long_answer'", [body.resumeJobId, user.id]); if (j.rows[0]) { jobId = j.rows[0].id; resume = j.rows[0].state.sections ?? []; } }
        const sections = Math.max(2, Math.min(10, Number(body.sections) || 5)), sections_done = resume.slice();
        if (!jobId) jobId = (await pool.query("insert into jobs (user_id, conversation_id, kind, status, total_steps) values ($1,$2,'long_answer','running',$3) returning id", [user.id, cid, sections])).rows[0].id;
        const r = await writeLongAnswer(provider, { request: text, sections, resume, signal: ac.signal,
          onSection: s => { const piece = (out ? '\n\n' : '') + '## ' + s.title + '\n\n' + s.text; out += piece; sections_done.push(s.text); ev({ type: 'delta', text: piece }); jobWrite('update jobs set done_steps = $1, state = $2, updated_at = now() where id = $3', [sections_done.length, JSON.stringify({ sections: sections_done }), jobId]); },
          onProgress: p => ev({ type: 'progress', ...p }) });
        if (!r.complete) { status = 'stopped'; stop = 'aborted'; }
      } else {
        let userPrompt = text;
        if (attachments.length > 0) {
          const fileDescriptions = [];
          for (const a of attachments) {
            const isImg = (a.mime || '').startsWith('image/');
            if (isImg) {
              fileDescriptions.push(`[Attached image: ${a.name}]`);
            } else {
              let fileBody = '';
              try {
                const attRow = await pool.query('select storage_path from attachments where id = $1', [a.id]);
                if (attRow.rows[0] && fs.existsSync(attRow.rows[0].storage_path)) {
                  fileBody = fs.readFileSync(attRow.rows[0].storage_path, 'utf8').slice(0, 100000);
                }
              } catch {}
              if (fileBody) {
                fileDescriptions.push(`[Attached file: ${a.name}]:\n\`\`\`\n${fileBody}\n\`\`\``);
              } else {
                fileDescriptions.push(`[Attached file: ${a.name}]`);
              }
            }
          }
          userPrompt = fileDescriptions.join('\n\n') + (text ? '\n\n' + text : '\n(The user provided these files)');
        }
        for await (const piece of provider.stream({ system: SYSTEM + (body.system ? '\n' + String(body.system).slice(0, 2000) : ''), messages: [...hist, { role: 'user', content: userPrompt }], maxTokens: 1024, signal: ac.signal })) { out += piece; ev({ type: 'delta', text: piece }); }
        if (ac.signal.aborted) { status = 'stopped'; stop = 'aborted'; }
      }
    } catch (e) {
      if (ac.signal.aborted) { status = 'stopped'; stop = 'aborted'; } else { status = 'error'; stop = 'error'; ev({ type: 'error', error: e.message || 'The model could not answer. Please try again.' }); console.error('chat error:', e.message); }
    }
    finished = true;
    await pool.query('update messages set content = $1, status = $2, stop_reason = $3 where id = $4', [JSON.stringify(out ? [{ type: 'text', text: out }] : []), status, stop, am]).catch(e => console.error(e.message));
    await jobChain;
    if (jobId) await pool.query('update jobs set status = $1, updated_at = now() where id = $2', [status === 'complete' ? 'done' : status === 'stopped' ? 'cancelled' : 'failed', jobId]).catch(() => { });
    ev({ type: 'done', status, jobId }); res.end();
    } catch (e) {
      console.error('Chat error:', e);
      if (!res.headersSent) send(res, 500, { error: 'Failed to process chat message.' });
      else res.end();
    }
  }

  const serveStatic = (req, res) => {
    if (!dist) { res.writeHead(404); return res.end('not found'); }
    let p = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = path.join(dist, p); if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-ancestors 'none'" });
    fs.createReadStream(f).pipe(res);
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
      if (!p.startsWith('/api/')) return serveStatic(req, res);
      if (m !== 'GET' && !/application\/json/.test(req.headers['content-type'] ?? '') && m !== 'DELETE') return send(res, 415, { error: 'Send JSON.' });
      if (p === '/api/signup' && m === 'POST') {
        const b = await readJson(req), email = String(b.email ?? '').trim().toLowerCase(), pw = String(b.password ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email.' });
        if (pw.length < 8) return send(res, 400, { error: 'Use a password with at least 8 characters.' });
        const c = await pool.connect();
        try {
          await c.query('begin');
          const u = await c.query('insert into users (email, password_hash) values ($1,$2) on conflict (email) do nothing returning id', [email, await hashPassword(pw)]);
          if (!u.rows[0]) { await c.query('rollback'); return send(res, 409, { error: 'That email is already registered. Sign in instead.' }); }
          await c.query('insert into profiles (id, display_name) values ($1,$2)', [u.rows[0].id, email.split('@')[0].slice(0, 40) || 'You']); await c.query('commit');
          return startSession(res, u.rows[0].id, { ok: true, email }, 201);
        } catch (e) { await c.query('rollback').catch(() => { }); throw e; } finally { c.release(); }
      }
      if (p === '/api/login' && m === 'POST') {
        const b = await readJson(req), r = await pool.query('select id, password_hash from users where email = $1', [String(b.email ?? '').trim().toLowerCase()]);
        const ok = r.rows[0] ? await verifyPassword(String(b.password ?? ''), r.rows[0].password_hash) : (await verifyPassword('x', 'scrypt$00$00'), false);
        if (!ok) return send(res, 401, { error: 'Email or password is not right.' });
        return startSession(res, r.rows[0].id, { ok: true });
      }
      const user = await userOf(req);
      if (p === '/api/logout' && m === 'POST') { const t = parseCookies(req.headers.cookie).naru_session; if (t) await pool.query('delete from sessions where token_hash = $1', [tokenHash(t)]); return send(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
      if (!user) return send(res, 401, { error: 'Please sign in.' });
      if (p === '/api/me' && m === 'GET') return send(res, 200, { email: user.email, name: user.display_name });
      if (p === '/api/upload' && m === 'POST') {
        const b = await readJson(req, 15_000_000);
        const { name = 'file.txt', mime = 'text/plain', data } = b;
        if (!data) return send(res, 400, { error: 'No file data provided.' });
        const raw = String(data).replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === 0 || buf.length > 10 * 1024 * 1024) return send(res, 400, { error: 'File must be between 1 byte and 10MB.' });
        const ext = path.extname(name).toLowerCase() || (mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png');
        const filename = crypto.randomUUID() + ext;
        const filepath = path.join(uploadsDir, filename);
        fs.writeFileSync(filepath, buf);
        const r = await pool.query('insert into attachments (user_id, name, mime, size_bytes, storage_path) values ($1,$2,$3,$4,$5) returning id, name, mime, size_bytes', [user.id, name.slice(0, 200), mime, buf.length, filepath]);
        const att = r.rows[0];
        return send(res, 201, { ok: true, attachment: { id: att.id, name: att.name, mime: att.mime, size: att.size_bytes, url: '/api/attachments/' + att.id } });
      }
      const attachMatch = p.match(/^\/api\/attachments\/([0-9a-f-]{36})$/);
      if (attachMatch && m === 'GET') {
        const r = await pool.query('select storage_path, mime, name from attachments where id = $1', [attachMatch[1]]);
        if (!r.rows[0] || !fs.existsSync(r.rows[0].storage_path)) return send(res, 404, { error: 'Attachment not found.' });
        res.writeHead(200, { 'content-type': r.rows[0].mime, 'cache-control': 'public, max-age=86400', 'content-length': fs.statSync(r.rows[0].storage_path).size });
        return fs.createReadStream(r.rows[0].storage_path).pipe(res);
      }
      if (p === '/api/chat' && m === 'POST') return chat(req, res, user);
      if (p === '/api/conversations' && m === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        const r = q ? await pool.query("select id, title, updated_at from conversations c where user_id = $1 and archived = false and (title ilike $2 or exists (select 1 from messages m where m.conversation_id = c.id and m.user_id = $1 and m.content::text ilike $2)) order by updated_at desc limit 100", [user.id, '%' + q.replace(/[%_\\]/g, '\\$&') + '%'])
          : await pool.query('select id, title, updated_at from conversations where user_id = $1 and archived = false order by updated_at desc limit 100', [user.id]);
        return send(res, 200, { conversations: r.rows });
      }
      const mm = p.match(/^\/api\/conversations\/([0-9a-f-]{36})$/);
      if (mm) {
        const cid = mm[1];
        if (m === 'GET') { const c = await pool.query('select id, title from conversations where id = $1 and user_id = $2', [cid, user.id]); if (!c.rows[0]) return send(res, 404, { error: 'Chat not found.' }); return send(res, 200, { ...c.rows[0], messages: (await branch(user.id, cid)).map(x => ({ id: x.id, role: x.role, text: textOf(x), attachments: attachmentsOf(x), status: x.status })) }); }
        if (m === 'PATCH') { const b = await readJson(req), t = String(b.title ?? '').trim().slice(0, 120); if (!t) return send(res, 400, { error: 'Give the chat a name.' }); const r = await pool.query('update conversations set title = $1, updated_at = now() where id = $2 and user_id = $3 returning id', [t, cid, user.id]); return r.rows[0] ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Chat not found.' }); }
        if (m === 'DELETE') { const r = await pool.query('delete from conversations where id = $1 and user_id = $2 returning id', [cid, user.id]); return r.rows[0] ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Chat not found.' }); }
      }
      send(res, 404, { error: 'Not found.' });
    } catch (e) { console.error(e); if (!res.headersSent) send(res, e.message === 'bad json' ? 400 : 500, { error: e.message === 'bad json' ? 'Bad request.' : 'Something went wrong.' }); else res.end(); }
  };
}

export function createApp(args) {
  return http.createServer(createHandler(args));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on('uncaughtException', err => console.error('Uncaught exception:', err?.message || err));
  process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));
  const { ensurePostgres } = await import('./init-db.mjs');
  const dbUrl = process.env.DATABASE_URL || 'postgres://naru:change-me-long-random@127.0.0.1:5432/naru';
  const embedded = await ensurePostgres(dbUrl);
  const a = process.argv.indexOf('--dist'), dist = a > 0 ? path.resolve(process.argv[a + 1]) : null;
  const isCloudPg = dbUrl.includes('supabase.co') || dbUrl.includes('pooler.supabase.com') || dbUrl.includes('neon.tech');
  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: isCloudPg ? { rejectUnauthorized: false } : undefined
  });
  const { resolveProvider } = await import('./providers.mjs');
  const provider = await resolveProvider();
  const port = Number(process.env.PORT || 3000);
  const server = createApp({ pool, dist, provider, opts: { secure: process.env.NARU_SECURE === '1' } });
  server.listen(port, '127.0.0.1', () => console.log('Naru on http://127.0.0.1:' + port + ' (provider: ' + provider.name + ')'));
  if (embedded) {
    const shutdown = async () => {
      server.close();
      await pool.end();
      await embedded.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}




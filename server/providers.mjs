// Model providers. Interface: complete({system, messages, maxTokens, signal}) -> string ; stream(...) -> async iterable of text pieces.
// 'mock' needs no model (tests, demos). 'openai' talks to any OpenAI-compatible server (llama.cpp llama-server, vLLM, Ollama).
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function mockProvider({ delay = 0 } = {}) {
  const reply = (system, messages) => {
    const u = messages.at(-1)?.content ?? '';
    if (/numbered outline/.test(system)) return '1. Background\n2. Main ideas\n3. Summary';
    if (/Extract only/.test(system)) return /NARU-FACT/.test(u) ? 'The key fact is: ' + (u.match(/NARU-FACT ([^.]*)\./)?.[1] ?? '') + '.' : 'NONE';
    if (/Merge these/.test(system)) return u.slice(0, 300);
    if (/one section/.test(system)) return 'This is the text of ' + (u.split('Write section ')[1] ?? 'the section') + '. Naru wrote it in its own batch.';
    if (/using only these notes/.test(system)) return 'From the notes: ' + u.split('Notes:\n')[1]?.slice(0, 400);
    return 'Naru (demo model) here. You said: "' + u.slice(0, 200) + '".\n\nA real model will answer once one is connected.\n\n```js\nconsole.log("hello from Naru");\n```';
  };
  return {
    name: 'mock',
    async complete({ system = '', messages, signal }) { if (delay) await sleep(delay); if (signal?.aborted) throw new Error('aborted'); return reply(system, messages); },
    async *stream({ system = '', messages, signal }) {
      for (const piece of reply(system, messages).match(/\S+\s*/g) ?? []) { if (signal?.aborted) return; if (delay) await sleep(delay); yield piece; }
    },
  };
}

export function openaiProvider({ baseUrl, apiKey = 'none', model = 'naru', fetchImpl = fetch }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = (system, messages, maxTokens, stream) => JSON.stringify({ model, stream, max_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] });
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey };
  return {
    name: 'openai',
    async complete({ system, messages, maxTokens = 512, signal }) {
      const r = await fetchImpl(url, { method: 'POST', headers, body: body(system, messages, maxTokens, false), signal });
      if (!r.ok) throw new Error('model server error ' + r.status);
      return (await r.json()).choices?.[0]?.message?.content ?? '';
    },
    async *stream({ system, messages, maxTokens = 1024, signal }) {
      const r = await fetchImpl(url, { method: 'POST', headers, body: body(system, messages, maxTokens, true), signal });
      if (!r.ok || !r.body) throw new Error('model server error ' + r.status);
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') return;
          try { const t = JSON.parse(data).choices?.[0]?.delta?.content; if (t) yield t; } catch { /* partial line */ }
        }
      }
    },
  };
}

export async function resolveProvider(env = process.env) {
  if (env.NARU_PROVIDER === 'openai') {
    return openaiProvider({ baseUrl: env.NARU_BASE_URL || 'http://127.0.0.1:8080/v1', apiKey: env.NARU_API_KEY, model: env.NARU_MODEL || 'naru' });
  }
  if (env.NARU_PROVIDER === 'mock') {
    return mockProvider({ delay: Number(env.NARU_MOCK_DELAY || 0) });
  }

  // Auto-detect Ollama on 127.0.0.1:11434
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: ac.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const models = data.models ?? [];
      if (models.length > 0) {
        const chosenModel = env.NARU_MODEL || models[0].name;
        console.log(`Auto-detected Ollama with model "${chosenModel}".`);
        return openaiProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: chosenModel });
      }
    }
  } catch {}

  // Auto-detect llama-server on 127.0.0.1:8080
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    const res = await fetch('http://127.0.0.1:8080/v1/models', { signal: ac.signal });
    clearTimeout(t);
    if (res.ok) {
      console.log('Auto-detected local model server on port 8080.');
      return openaiProvider({ baseUrl: 'http://127.0.0.1:8080/v1', model: env.NARU_MODEL || 'naru' });
    }
  } catch {}

  return mockProvider({ delay: Number(env.NARU_MOCK_DELAY || 0) });
}

export function providerFromEnv(env = process.env) {
  return env.NARU_PROVIDER === 'openai' ? openaiProvider({ baseUrl: env.NARU_BASE_URL || 'http://127.0.0.1:8080/v1', apiKey: env.NARU_API_KEY, model: env.NARU_MODEL || 'naru' }) : mockProvider({ delay: Number(env.NARU_MOCK_DELAY || 0) });
}


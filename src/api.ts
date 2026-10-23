export type Attachment = { id: string; name: string; url: string; mime?: string; size?: number };
export type Msg = { id: string; role: 'user' | 'assistant'; text: string; attachments?: Attachment[]; status?: string };
export type Conv = { id: string; title: string; updated_at: string };
export type Progress = { stage: 'read' | 'write' | 'answer'; done: number; total: number };

async function json<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data: any = {}; try { data = await r.json(); } catch { /* empty */ }
  return { status: r.status, data };
}
export const api = {
  me: () => json<{ email: string; name: string }>('GET', '/api/me'),
  signup: (email: string, password: string) => json<{}>('POST', '/api/signup', { email, password }),
  login: (email: string, password: string) => json<{}>('POST', '/api/login', { email, password }),
  logout: () => json<{}>('POST', '/api/logout', {}),
  list: (q = '') => json<{ conversations: Conv[] }>('GET', '/api/conversations' + (q ? '?q=' + encodeURIComponent(q) : '')),
  open: (id: string) => json<{ id: string; title: string; messages: Msg[] }>('GET', '/api/conversations/' + id),
  rename: (id: string, title: string) => json<{}>('PATCH', '/api/conversations/' + id, { title }),
  remove: (id: string) => json<{}>('DELETE', '/api/conversations/' + id),
  upload: async (file: File): Promise<{ status: number; data: { ok?: boolean; attachment?: Attachment; error?: string } }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        const res = await json<{ ok: boolean; attachment: Attachment }>('POST', '/api/upload', {
          name: file.name,
          mime: file.type || 'image/png',
          data: base64,
        });
        resolve(res);
      };
      reader.onerror = () => resolve({ status: 500, data: { error: 'Failed to read file.' } });
      reader.readAsDataURL(file);
    });
  },
};

export type ChatEvent = { type: 'start'; conversationId: string; messageId: string } | { type: 'delta'; text: string } | ({ type: 'progress' } & Progress) | { type: 'error'; error: string } | { type: 'done'; status: string; jobId: string | null };

/** POST /api/chat and read the server-sent events. Abort the signal to stop: the server keeps what was written so far. */
export async function chat(body: object, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<{ status: number; error?: string }> {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) { let e = 'Something went wrong.'; try { e = (await r.json()).error ?? e; } catch { /* */ } return { status: r.status, error: e }; }
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ } } }
  }
  return { status: 200 };
}

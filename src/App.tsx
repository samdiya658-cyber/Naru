import { useCallback, useEffect, useRef, useState } from 'react';
import { api, chat, type Attachment, type Conv, type Msg, type Progress } from './api';
import { Markdown } from './components/Markdown';

type Me = { email: string; name: string } | null;

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in'), [email, setEmail] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await (mode === 'in' ? api.login : api.signup)(email, pw); setBusy(false);
    if (r.status < 300) onDone(); else setErr(r.data.error ?? 'Something went wrong.');
  }
  return (<main className="auth"><form onSubmit={submit} aria-labelledby="auth-title">
    <div className="logo" aria-hidden="true">N</div><h1 id="auth-title">Naru</h1><p className="muted">{mode === 'in' ? 'Sign in to keep chatting.' : 'Create an account to start.'}</p>
    <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={mode === 'up' ? 8 : 1} value={pw} onChange={e => setPw(e.target.value)} /></label>
    {err && <p role="alert" className="err">{err}</p>}
    <button className="primary" disabled={busy}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
    <button type="button" className="link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); }}>{mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}</button>
  </form></main>);
}

function progressText(p: Progress | null) {
  if (!p) return '';
  return p.stage === 'read' ? `Reading part ${p.done} of ${p.total}` : p.stage === 'write' ? `Writing section ${p.done} of ${p.total}` : 'Putting the answer together';
}

function Chat({ me, onLogout }: { me: NonNullable<Me>; onLogout: () => void }) {
  const [convs, setConvs] = useState<Conv[]>([]), [cid, setCid] = useState<string | null>(null), [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [prog, setProg] = useState<Progress | null>(null), [err, setErr] = useState('');
  const [long, setLong] = useState(false), [imageMode, setImageMode] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]), [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [q, setQ] = useState(''), [open, setOpen] = useState(false), [copied, setCopied] = useState('');
  const ac = useRef<AbortController | null>(null), end = useRef<HTMLDivElement>(null), ta = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (query = '') => { const r = await api.list(query); if (r.status === 200) setConvs(r.data.conversations); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const t = setTimeout(() => void refresh(q), 200); return () => clearTimeout(t); }, [q, refresh]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, prog]);
  useEffect(() => { const t = ta.current; if (t) { t.style.height = 'auto'; t.style.height = Math.min(200, t.scrollHeight) + 'px'; } }, [text]);

  async function openChat(id: string) { const r = await api.open(id); if (r.status === 200) { setCid(id); setMsgs(r.data.messages); setErr(''); setOpen(false); } }
  function newChat() { setCid(null); setMsgs([]); setAttachments([]); setErr(''); setOpen(false); ta.current?.focus(); }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    setUploading(true); setErr('');
    for (const f of list) {
      if (f.size > 10 * 1024 * 1024) { setErr(`"${f.name}" is larger than 10MB.`); continue; }
      const res = await api.upload(f);
      if (res.status === 201 && res.data.attachment) {
        setAttachments(prev => [...prev, res.data.attachment!]);
      } else {
        setErr(res.data.error ?? 'Failed to upload image.');
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      const imgFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'));
      if (imgFiles.length > 0) { e.preventDefault(); void handleFiles(imgFiles); }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
  };

  async function send(override?: string) {
    const t = (override ?? text).trim();
    if ((!t && attachments.length === 0) || busy || uploading) return;
    setErr(''); setText(''); setBusy(true); setProg(null);
    const currAttachments = [...attachments];
    setAttachments([]);
    const uid = 'u' + Date.now(), aid = 'a' + Date.now();
    setMsgs(m => [...m, { id: uid, role: 'user', text: t, attachments: currAttachments }, { id: aid, role: 'assistant', text: '', status: 'streaming' }]);
    ac.current = new AbortController(); let newId = cid;
    try {
      const r = await chat({
        conversationId: cid ?? undefined,
        text: t,
        attachments: currAttachments,
        mode: imageMode ? 'image' : undefined,
        long: long ? 'answer' : undefined,
      }, e => {
        if (e.type === 'start') { newId = e.conversationId; setCid(e.conversationId); }
        else if (e.type === 'delta') setMsgs(m => m.map(x => x.id === aid ? { ...x, text: x.text + e.text } : x));
        else if (e.type === 'progress') setProg(e);
        else if (e.type === 'error') setErr(e.error);
        else if (e.type === 'done') setMsgs(m => m.map(x => x.id === aid ? { ...x, status: e.status } : x));
      }, ac.current.signal);
      if (r.error) {
        setErr(r.error);
        setMsgs(m => m.filter(x => x.id !== uid && x.id !== aid));
        setText(t);
        setAttachments(currAttachments);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') { setErr('The connection dropped. Your message is saved; open the chat again to see how far it got.'); }
    }
    setBusy(false); setProg(null); void refresh(q);
    if (newId) { const r = await api.open(newId); if (r.status === 200) setMsgs(r.data.messages); }
  }

  const stop = () => ac.current?.abort();
  async function copy(id: string, s: string) { try { await navigator.clipboard.writeText(s); setCopied(id); setTimeout(() => setCopied(''), 1200); } catch { /* */ } }
  async function rename(c: Conv) { const t = prompt('Rename chat', c.title); if (t?.trim()) { await api.rename(c.id, t.trim()); void refresh(q); } }
  async function remove(c: Conv) { if (!confirm('Delete this chat? This cannot be undone.')) return; await api.remove(c.id); if (cid === c.id) newChat(); void refresh(q); }
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } };

  return (<div className="shell">
    <aside className={'side' + (open ? ' open' : '')} aria-label="Chats">
      <div className="side-top"><strong className="brand">Naru</strong><button className="primary sm" onClick={newChat}>New chat</button></div>
      <input className="search" type="search" placeholder="Search chats" aria-label="Search chats" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="convs">{convs.map(c => (<li key={c.id} className={c.id === cid ? 'on' : ''}>
        <button className="conv" onClick={() => void openChat(c.id)}>{c.title}</button>
        <span className="conv-actions"><button aria-label={'Rename ' + c.title} onClick={() => void rename(c)}>✎</button><button aria-label={'Delete ' + c.title} onClick={() => void remove(c)}>🗑</button></span></li>))}
        {!convs.length && <li className="muted empty">{q ? 'No chats match.' : 'No chats yet.'}</li>}</ul>
      <div className="side-bottom"><span className="muted who">{me.email}</span><button className="link" onClick={onLogout}>Sign out</button></div>
    </aside>
    {open && <div className="scrim" onClick={() => setOpen(false)} />}
    <section className="main" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <header className="bar"><button className="menu" aria-label="Open chats" onClick={() => setOpen(true)}>☰</button><span className="bar-title">{convs.find(c => c.id === cid)?.title ?? 'New chat'}</span></header>
      <div className="thread" role="log" aria-live="polite">
        {!msgs.length && <div className="hello">
          <div className="logo" aria-hidden="true">N</div>
          <h2>How can I help?</h2>
          <p className="muted">Ask questions, generate images, or attach photos to analyze.</p>
          <div className="chips">
            {['Explain how rainbows form', '🎨 /image A futuristic neon cyberpunk city in rain', '🎨 /image A cute golden retriever puppy in flowers'].map(s => <button key={s} onClick={() => void send(s)}>{s}</button>)}
          </div>
        </div>}
        {msgs.map(m => (<article key={m.id} className={'msg ' + m.role}>
          {m.role === 'user' ? (
            <div className="bubble">
              {m.attachments && m.attachments.length > 0 && (
                <div className="bubble-attachments">
                  {m.attachments.map(att => (
                    <img key={att.id} src={att.url} alt={att.name} className="bubble-img" onClick={() => setLightbox(att.url)} title={att.name + ' (click to view)'} />
                  ))}
                </div>
              )}
              {m.text && <div className="bubble-text">{m.text}</div>}
            </div>
          ) : (<div className="reply">
            {m.text ? <Markdown text={m.text} onImageClick={url => setLightbox(url)} /> : m.status === 'streaming' ? <span className="dots" aria-label="Naru is thinking"><i /><i /><i /></span> : null}
            {m.status === 'stopped' && <p className="muted note">Stopped. This is what was written so far.</p>}
            {m.status === 'error' && <p className="err note">This answer failed. Try sending the message again.</p>}
            {m.status !== 'streaming' && m.text && <div className="actions"><button onClick={() => void copy(m.id, m.text)}>{copied === m.id ? 'Copied' : 'Copy'}</button></div>}
          </div>)}
        </article>))}
        {prog && <div className="progress" role="status"><div className="bar-fill" style={{ width: Math.round(100 * prog.done / Math.max(1, prog.total)) + '%' }} /><span>{progressText(prog)}</span></div>}
        {err && <p role="alert" className="err banner">{err}</p>}
        <div ref={end} />
      </div>
      <footer className="composer">
        <div className="composer-options">
          <label className="toggle-chip"><input type="checkbox" checked={long} onChange={e => { setLong(e.target.checked); if (e.target.checked) setImageMode(false); }} /> 📄 Long answer</label>
          <button type="button" className={'mode-btn' + (imageMode ? ' active' : '')} onClick={() => { setImageMode(!imageMode); if (!imageMode) setLong(false); }}>🎨 {imageMode ? 'Image Mode On' : 'Generate Image'}</button>
        </div>

        {attachments.length > 0 && (
          <div className="pending-strip">
            {attachments.map((att, idx) => (
              <div key={att.id || idx} className="pending-chip">
                <img src={att.url} alt={att.name} className="pending-thumb" onClick={() => setLightbox(att.url)} />
                <span className="pending-name">{att.name}</span>
                <button type="button" className="pending-remove" onClick={() => setAttachments(a => a.filter((_, i) => i !== idx))} title="Remove image">✕</button>
              </div>
            ))}
            {uploading && <span className="pending-uploading">Uploading...</span>}
          </div>
        )}

        <div className="row">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }} onChange={e => e.target.files && void handleFiles(e.target.files)} />
          <button type="button" className="btn-icon" title="Import / attach images" onClick={() => fileInput.current?.click()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
          </button>
          <textarea
            ref={ta}
            rows={1}
            placeholder={imageMode ? "Describe the image you want to generate (e.g. futuristic city in neon rain)..." : "Message Naru, paste an image, or type /image <prompt>..."}
            aria-label="Message Naru"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          {busy ? <button className="send stop" onClick={stop} aria-label="Stop">■</button> : <button className="send" onClick={() => void send()} disabled={(!text.trim() && !attachments.length) || uploading} aria-label="Send">↑</button>}
        </div>
        <p className="muted tiny">Naru can make mistakes. Check anything important.</p>
      </footer>
    </section>

    {lightbox && (
      <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
        <div className="lightbox-modal" onClick={e => e.stopPropagation()}>
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close preview">✕</button>
          <img src={lightbox} alt="Enlarged view" className="lightbox-img" />
          <div className="lightbox-bar">
            <a href={lightbox} target="_blank" rel="noreferrer" download className="lightbox-dl">Download Image</a>
          </div>
        </div>
      </div>
    )}
  </div>);
}

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const load = useCallback(async () => { const r = await api.me(); setMe(r.status === 200 ? r.data : null); }, []);
  useEffect(() => { void load(); }, [load]);
  if (me === undefined) return <main className="auth"><p className="muted">Loading…</p></main>;
  if (!me) return <Auth onDone={load} />;
  return <Chat me={me} onLogout={async () => { await api.logout(); setMe(null); }} />;
}

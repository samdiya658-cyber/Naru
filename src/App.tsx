import { useCallback, useEffect, useRef, useState } from 'react';
import { api, chat, type Attachment, type Conv, type Msg, type Progress } from './api';
import { Markdown } from './components/Markdown';
import { ArtifactPanel } from './components/ArtifactPanel';
import { ArtifactCard } from './components/ArtifactCard';
import { TaskChecklist, parseTaskPlan } from './components/TaskChecklist';
import { extractArtifacts, type Artifact } from './lib/artifacts';

type Me = { email: string; name: string } | null;

function isImageAttachment(att: Attachment) {
  return (att.type && att.type.startsWith('image/')) || /\.(png|jpe?g|webp|gif|svg)$/i.test(att.name);
}

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
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const lastAutoOpenedMsgId = useRef<string | null>(null);
  const ac = useRef<AbortController | null>(null), end = useRef<HTMLDivElement>(null), ta = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (query = '') => { const r = await api.list(query); if (r.status === 200) setConvs(r.data.conversations); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const t = setTimeout(() => void refresh(q), 200); return () => clearTimeout(t); }, [q, refresh]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, prog]);
  useEffect(() => { const t = ta.current; if (t) { t.style.height = 'auto'; t.style.height = Math.min(200, t.scrollHeight) + 'px'; } }, [text]);

  // Auto-activate latest artifact when generated
  useEffect(() => {
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'assistant' && last.text && last.id !== lastAutoOpenedMsgId.current) {
        const { artifacts } = extractArtifacts(last.text, last.id);
        if (artifacts.length > 0) {
          lastAutoOpenedMsgId.current = last.id;
          setActiveArtifact(artifacts[artifacts.length - 1]);
        }
      }
    }
  }, [msgs]);

  async function openChat(id: string) { const r = await api.open(id); if (r.status === 200) { setCid(id); setMsgs(r.data.messages); setErr(''); setOpen(false); setActiveArtifact(null); } }
  function newChat() { setCid(null); setMsgs([]); setAttachments([]); setErr(''); setOpen(false); setActiveArtifact(null); ta.current?.focus(); }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true); setErr('');
    for (const f of list) {
      if (f.size > 10 * 1024 * 1024) { setErr(`"${f.name}" is larger than 10MB.`); continue; }
      const res = await api.upload(f);
      if (res.status === 201 && res.data.attachment) {
        setAttachments(prev => [...prev, res.data.attachment!]);
      } else {
        setErr(res.data.error ?? 'Failed to upload file.');
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      void handleFiles(e.clipboardData.files);
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

    const isImageReq = imageMode
      || /^\s*(🎨\s*)?(\/image|\/imagine)\b/i.test(t)
      || /\b(\/image|\/imagine)\b/i.test(t)
      || /\b(generate|create|draw|paint|render|make)\s+(an?\s+)?(image|picture|photo)\b/i.test(t);

    if (imageMode) setImageMode(false);

    try {
      const r = await chat({
        conversationId: cid ?? undefined,
        text: t,
        attachments: currAttachments,
        mode: isImageReq ? 'image' : undefined,
        long: long ? 'answer' : undefined,
      }, e => {
        if (e.type === 'start') { newId = e.conversationId; setCid(e.conversationId); }
        else if (e.type === 'delta') setMsgs(m => m.map(x => x.id === aid ? { ...x, text: (e.replace ? e.text : x.text + e.text) } : x));
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

  return (<div className={`shell ${activeArtifact ? 'has-artifact' : ''}`}>
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
      <header className="bar">
        <button className="menu" aria-label="Open chats" onClick={() => setOpen(true)}>☰</button>
        <span className="bar-title">{convs.find(c => c.id === cid)?.title ?? 'New chat'}</span>
        {activeArtifact && (
          <button
            type="button"
            className="btn-artifact-toggle"
            onClick={() => setActiveArtifact(null)}
            title="Close interactive workspace"
          >
            <span>Workspace: {activeArtifact.title.slice(0, 20)}...</span>
            ✕
          </button>
        )}
      </header>
      <div className="thread" role="log" aria-live="polite">
        {!msgs.length && <div className="hello">
          <div className="logo" aria-hidden="true">N</div>
          <h2>Naru Coworker</h2>
          <p className="muted">Your AI partner for building interactive apps, writing code, generating graphics, and executing tasks.</p>
          <div className="chips">
            {[
              '⚡ Interactive Pomodoro Timer App',
              '🎨 Futuristic AI Startup Logo in SVG',
              '🎮 Retro Snake Game in HTML and JS',
              '🎨 /image Neon cyberpunk cityscape in rain',
              '📄 1-Page Startup Pitch Deck'
            ].map(s => <button key={s} onClick={() => void send(s)}>{s}</button>)}
          </div>
        </div>}
        {msgs.map(m => (<article key={m.id} className={'msg ' + m.role}>
          {m.role === 'user' ? (
            <div className="bubble">
              {m.attachments && m.attachments.length > 0 && (
                <div className="bubble-attachments">
                  {m.attachments.map(att => (
                    isImageAttachment(att) ? (
                      <img key={att.id} src={att.url} alt={att.name} className="bubble-img" onClick={() => setLightbox(att.url)} title={att.name + ' (click to view)'} />
                    ) : (
                      <a key={att.id} href={att.url} target="_blank" rel="noreferrer" download={att.name} className="bubble-doc-chip" title="Click to download attachment">
                        <span className="bubble-doc-icon">📄</span>
                        <span className="bubble-doc-name">{att.name}</span>
                        {att.size ? <span className="bubble-doc-size">{Math.round(att.size / 1024)} KB</span> : null}
                      </a>
                    )
                  ))}
                </div>
              )}
              {m.text && <div className="bubble-text">{m.text}</div>}
            </div>
          ) : (() => {
            const plan = parseTaskPlan(m.text);
            const cleanText = plan ? plan.cleanText : m.text;
            const { artifacts } = extractArtifacts(cleanText, m.id);
            return (
              <div className="reply">
                {plan && <TaskChecklist steps={plan.steps} />}
                {artifacts.length > 0 && (
                  <div className="artifacts-list">
                    {artifacts.map(art => (
                      <ArtifactCard
                        key={art.id}
                        artifact={art}
                        isActive={activeArtifact?.id === art.id}
                        onOpen={a => setActiveArtifact(a)}
                      />
                    ))}
                  </div>
                )}
                {cleanText ? (
                  <Markdown
                    text={cleanText}
                    onImageClick={url => setLightbox(url)}
                    onOpenArtifact={art => setActiveArtifact({
                      id: 'art-' + Date.now(),
                      title: art.title,
                      type: art.language === 'html' ? 'html' : art.language === 'svg' ? 'svg' : 'code',
                      language: art.language,
                      content: art.content,
                      messageId: m.id
                    })}
                  />
                ) : m.status === 'streaming' ? (
                  <span className="dots" aria-label="Naru is thinking"><i /><i /><i /></span>
                ) : null}
                {m.status === 'stopped' && <p className="muted note">Stopped. This is what was written so far.</p>}
                {m.status === 'error' && <p className="err note">This answer failed. Try sending the message again.</p>}
                {m.status !== 'streaming' && cleanText && <div className="actions"><button onClick={() => void copy(m.id, cleanText)}>{copied === m.id ? 'Copied' : 'Copy'}</button></div>}
              </div>
            );
          })()}
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
              <div key={att.id || idx} className={isImageAttachment(att) ? "pending-chip" : "pending-chip pending-doc-chip"}>
                {isImageAttachment(att) ? (
                  <img src={att.url} alt={att.name} className="pending-thumb" onClick={() => setLightbox(att.url)} />
                ) : (
                  <span className="pending-doc-icon">📄</span>
                )}
                <span className="pending-name">{att.name}</span>
                <button type="button" className="pending-remove" onClick={() => setAttachments(a => a.filter((_, i) => i !== idx))} title="Remove file">✕</button>
              </div>
            ))}
            {uploading && <span className="pending-uploading">Uploading...</span>}
          </div>
        )}

        <div className="row">
          <input ref={fileInput} type="file" accept="image/*,.txt,.csv,.json,.md,.js,.ts,.jsx,.tsx,.py,.html,.css,.xml,.yaml,.yml,.sql,.pdf" multiple style={{ display: 'none' }} onChange={e => e.target.files && void handleFiles(e.target.files)} />
          <button type="button" className="btn-icon" title="Attach files (images, data, code, documents)" onClick={() => fileInput.current?.click()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
          </button>
          <textarea
            ref={ta}
            rows={1}
            placeholder={imageMode ? "Describe the image you want to generate (e.g. futuristic city in neon rain)..." : "Ask Naru to build an app, create an SVG graphic, write code, or execute tasks..."}
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

    {activeArtifact && (
      <ArtifactPanel
        artifact={activeArtifact}
        onClose={() => setActiveArtifact(null)}
      />
    )}

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

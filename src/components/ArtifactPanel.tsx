import { useState, useMemo, useEffect, useRef } from 'react';
import type { Artifact } from '../lib/artifacts';
import { SyntaxCode } from './SyntaxCode';

export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'preview' | 'code'>(artifact.type === 'code' && artifact.language !== 'html' ? 'code' : 'preview');
  const [copied, setCopied] = useState(false);
  const [content, setContent] = useState(artifact.content);
  const [isEditing, setIsEditing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sync content when new artifact is passed
  useEffect(() => {
    setContent(artifact.content);
    if (artifact.type === 'code' && artifact.language !== 'html' && artifact.language !== 'svg') {
      setTab('code');
    } else {
      setTab('preview');
    }
    setIsEditing(false);
  }, [artifact.id, artifact.content, artifact.type, artifact.language]);

  const isModified = content !== artifact.content;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const downloadFile = () => {
    let ext = '.txt';
    if (artifact.type === 'html' || artifact.language === 'html') ext = '.html';
    else if (artifact.type === 'svg' || artifact.language === 'svg') ext = '.svg';
    else if (artifact.language === 'javascript' || artifact.language === 'js') ext = '.js';
    else if (artifact.language === 'typescript' || artifact.language === 'ts') ext = '.ts';
    else if (artifact.language === 'python' || artifact.language === 'py') ext = '.py';
    else if (artifact.language === 'markdown' || artifact.language === 'md') ext = '.md';
    else if (artifact.language === 'css') ext = '.css';

    const safeTitle = (artifact.title || 'artifact').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const popOut = () => {
    const w = window.open('', '_blank');
    if (w) {
      if (artifact.type === 'html' || artifact.language === 'html') {
        w.document.open();
        w.document.write(content);
        w.document.close();
      } else if (artifact.type === 'svg') {
        w.document.open();
        w.document.write(`<!DOCTYPE html><html><head><title>${artifact.title}</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#121212;}</style></head><body>${content}</body></html>`);
        w.document.close();
      } else {
        w.document.open();
        w.document.write(`<!DOCTYPE html><html><head><title>${artifact.title}</title><style>body{margin:24px;font-family:monospace;white-space:pre-wrap;background:#18181b;color:#f4f4f5;}</style></head><body>${content.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body></html>`);
        w.document.close();
      }
    }
  };

  const preparedHtml = useMemo(() => {
    if (artifact.type !== 'html' && artifact.language !== 'html') return '';
    let html = content.trim();
    // Wrap snippets in standard boilerplate if missing html tags
    if (!html.toLowerCase().includes('<html') && !html.toLowerCase().includes('<!doctype')) {
      html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${artifact.title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100 p-4">
  ${html}
</body>
</html>`;
    }
    return html;
  }, [content, artifact.language, artifact.title, artifact.type]);

  return (
    <aside className="artifact-panel" aria-label="Artifact Workspace">
      <header className="artifact-header">
        <div className="artifact-title-group">
          <span className="artifact-icon" aria-hidden="true">
            {artifact.type === 'html' ? '⚡' : artifact.type === 'svg' ? '🎨' : '📄'}
          </span>
          <div className="artifact-info">
            <h3 className="artifact-title" title={artifact.title}>{artifact.title}</h3>
            <span className="artifact-badge">{artifact.language.toUpperCase()}</span>
            {isModified && <span className="artifact-modified-badge">Edited</span>}
          </div>
        </div>

        <div className="artifact-nav">
          {(artifact.type === 'html' || artifact.type === 'svg') && (
            <div className="artifact-segmented">
              <button
                className={`artifact-tab ${tab === 'preview' ? 'active' : ''}`}
                onClick={() => setTab('preview')}
                title="Interactive Live Preview"
              >
                Preview
              </button>
              <button
                className={`artifact-tab ${tab === 'code' ? 'active' : ''}`}
                onClick={() => setTab('code')}
                title="View / Edit Source Code"
              >
                {isEditing ? 'Editing' : 'Code'}
              </button>
            </div>
          )}

          <div className="artifact-actions">
            <button className="artifact-btn" onClick={copyCode} title="Copy code">
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button className="artifact-btn" onClick={downloadFile} title="Download file">
              Download
            </button>
            <button className="artifact-btn icon-only" onClick={popOut} title="Open in new window">
              ↗
            </button>
            <button className="artifact-btn icon-only close" onClick={onClose} title="Close workspace">
              ✕
            </button>
          </div>
        </div>
      </header>

      <div className="artifact-body">
        {tab === 'preview' ? (
          artifact.type === 'html' || artifact.language === 'html' ? (
            <iframe
              ref={iframeRef}
              className="artifact-preview-frame"
              title={artifact.title}
              srcDoc={preparedHtml}
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
            />
          ) : artifact.type === 'svg' ? (
            <div
              className="artifact-svg-container"
              dangerouslySetInnerHTML={{ __html: content }}
            />
          ) : (
            <div className="artifact-code-view">
              <SyntaxCode text={content} language={artifact.language} lineNumbers />
            </div>
          )
        ) : (
          <div className="artifact-editor-container">
            <div className="artifact-editor-toolbar">
              <span className="artifact-editor-status">
                {isEditing ? '✏️ Edit mode' : '👀 Syntax highlighted'}
              </span>
              <div className="artifact-editor-btns">
                <button
                  type="button"
                  className={`editor-toggle-btn ${isEditing ? 'active' : ''}`}
                  onClick={() => setIsEditing(!isEditing)}
                >
                  {isEditing ? 'View Highlighted' : '✏️ Co-Edit Code'}
                </button>
                {isEditing && (
                  <button
                    type="button"
                    className="editor-apply-btn"
                    onClick={() => setTab('preview')}
                    title="Run changes in preview"
                  >
                    ▶ Run & Preview
                  </button>
                )}
                {isModified && (
                  <button
                    type="button"
                    className="editor-reset-btn"
                    onClick={() => { setContent(artifact.content); setIsEditing(false); }}
                    title="Reset to Naru's original code"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {isEditing ? (
              <textarea
                className="artifact-code-textarea"
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Edit code directly here..."
                spellCheck={false}
              />
            ) : (
              <div className="artifact-code-view">
                <SyntaxCode text={content} language={artifact.language} lineNumbers />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

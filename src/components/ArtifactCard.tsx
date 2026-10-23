import type { Artifact } from '../lib/artifacts';

export function ArtifactCard({
  artifact,
  onOpen,
  isActive = false,
}: {
  artifact: Artifact;
  onOpen: (artifact: Artifact) => void;
  isActive?: boolean;
}) {
  const icon = artifact.type === 'html' ? '⚡' : artifact.type === 'svg' ? '🎨' : '📄';

  return (
    <div
      className={`artifact-card ${isActive ? 'active' : ''}`}
      onClick={() => onOpen(artifact)}
      role="button"
      tabIndex={0}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onOpen(artifact)}
    >
      <div className="artifact-card-icon" aria-hidden="true">{icon}</div>
      <div className="artifact-card-main">
        <div className="artifact-card-title">{artifact.title}</div>
        <div className="artifact-card-sub">
          <span className="artifact-card-tag">{artifact.language.toUpperCase()}</span>
          <span>• Click to open interactive artifact</span>
        </div>
      </div>
      <div className="artifact-card-open">
        <span>View</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
    </div>
  );
}

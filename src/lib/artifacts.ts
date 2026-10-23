export interface Artifact {
  id: string;
  title: string;
  type: 'html' | 'svg' | 'markdown' | 'code';
  language: string;
  content: string;
  messageId?: string;
}

/**
 * Extracts artifacts from assistant messages.
 * Looks for:
 * 1. <antArtifact ...>...</antArtifact> or <artifact ...>...</artifact>
 * 2. Markdown code blocks with previewable languages (html, svg) or explicit titles
 */
export function extractArtifacts(text: string, messageId?: string): { cleanText: string; artifacts: Artifact[] } {
  const artifacts: Artifact[] = [];
  let cleanText = text;

  // 1. Tag-based artifacts: <antArtifact identifier="id" type="application/vnd.ant.code" title="Title" language="html">content</antArtifact>
  const tagRegex = /<(?:antArtifact|artifact)\s+([^>]*?)>([\s\S]*?)<\/(?:antArtifact|artifact)>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagRegex.exec(text)) !== null) {
    const rawAttrs = tagMatch[1];
    const content = tagMatch[2].trim();
    const idMatch = rawAttrs.match(/identifier=["']([^"']+)["']/i);
    const titleMatch = rawAttrs.match(/title=["']([^"']+)["']/i);
    const typeMatch = rawAttrs.match(/type=["']([^"']+)["']/i);
    const langMatch = rawAttrs.match(/language=["']([^"']+)["']/i);

    const title = titleMatch ? titleMatch[1] : 'Interactive Artifact';
    const id = idMatch ? idMatch[1] : 'artifact-' + Math.random().toString(36).slice(2, 8);
    const lang = (langMatch ? langMatch[1] : 'html').toLowerCase();

    let type: Artifact['type'] = 'code';
    if (lang === 'html' || lang === 'htm' || typeMatch?.[1]?.includes('html')) type = 'html';
    else if (lang === 'svg' || typeMatch?.[1]?.includes('svg')) type = 'svg';
    else if (lang === 'markdown' || lang === 'md' || typeMatch?.[1]?.includes('markdown')) type = 'markdown';

    artifacts.push({ id, title, type, language: lang, content, messageId });
  }

  // 2. Code blocks detection: ```html or ```svg or ```javascript with interactive markup
  if (artifacts.length === 0) {
    const blockRegex = /```([a-zA-Z0-9_-]+)?(?:\s+([^\n]+))?\n([\s\S]*?)```/g;
    let blockMatch: RegExpExecArray | null;
    let index = 1;

    while ((blockMatch = blockRegex.exec(text)) !== null) {
      const rawLang = (blockMatch[1] || '').toLowerCase().trim();
      const meta = (blockMatch[2] || '').trim();
      const content = blockMatch[3].trim();

      // Only treat substantial HTML, SVG, or titled code as artifacts
      const isHtml = (rawLang === 'html' || rawLang === 'htm') && content.length > 80;
      const isSvg = (rawLang === 'svg' || content.startsWith('<svg')) && content.length > 50;
      const isInteractiveApp = (rawLang === 'javascript' || rawLang === 'typescript' || rawLang === 'jsx' || rawLang === 'tsx') && (content.includes('document.createElement') || content.includes('addEventListener') || content.includes('return (') || meta.toLowerCase().includes('app') || meta.toLowerCase().includes('game'));
      const hasTitle = meta.length > 0;

      if (isHtml || isSvg || (isInteractiveApp && content.length > 150) || (hasTitle && content.length > 100)) {
        let type: Artifact['type'] = 'code';
        if (isHtml) type = 'html';
        else if (isSvg) type = 'svg';

        let title = meta || (isHtml ? 'Interactive Web App' : isSvg ? 'SVG Vector Graphic' : isInteractiveApp ? 'Interactive Component' : `Code Artifact (${rawLang || 'script'})`);
        if (meta.startsWith('title=')) title = meta.replace(/^title=["']?|["']?$/g, '');

        artifacts.push({
          id: `block-${index++}`,
          title,
          type,
          language: rawLang || (isHtml ? 'html' : isSvg ? 'svg' : 'javascript'),
          content,
          messageId
        });
      }
    }
  }

  return { cleanText, artifacts };
}

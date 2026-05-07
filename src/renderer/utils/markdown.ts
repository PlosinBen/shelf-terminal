import { marked, type Tokens } from 'marked';

// Centralised marked configuration for the renderer.
// All <a> tags get target=_blank + rel=noopener — without this, clicking a
// link inside agent / PM / notes markdown navigates the renderer window away
// and trashes app state. target=_blank routes through window.open semantics
// which the main process intercepts via setWindowOpenHandler → openExternal.

marked.use({
  renderer: {
    link(token: Tokens.Link): string {
      const text = (this as any).parser.parseInline(token.tokens);
      const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      const href = escapeAttr(token.href);
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

export interface RenderOptions {
  /** Treat single newlines as <br> (chat-style). Default false (CommonMark). */
  breaks?: boolean;
}

export function renderMarkdown(text: string, opts: RenderOptions = {}): string {
  return marked.parse(text, {
    gfm: true,
    breaks: opts.breaks ?? false,
    async: false,
  }) as string;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

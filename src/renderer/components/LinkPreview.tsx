import React, { useEffect, useRef, useState } from 'react';
import type { LinkPreviewResult } from '@shared/link-open-intent';

export function LinkPreview({ result, close }: { result: LinkPreviewResult; close: () => void }) {
  const selected = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState('');
  useEffect(() => { selected.current?.scrollIntoView({ block: 'center' }); }, [result]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [close]);
  return <div className="link-preview-overlay" role="dialog" aria-modal="true" aria-label="Link preview">
    <div className="link-preview-panel">
      <h2>{result.kind === 'message' ? result.title : result.path}</h2>
      <pre className="link-preview-original">{result.url}</pre>
      <button onClick={() => { void navigator.clipboard.writeText(result.url).catch(() => setCopyError('Could not copy link')); }}>Copy</button>
      <button autoFocus onClick={close}>Close</button>
      {copyError && <p role="alert">{copyError}</p>}
      {result.kind === 'file' && <pre className="link-preview-content">{result.content.split('\n').map((line, index) => (
        <div key={index} ref={index + 1 === result.line ? selected : undefined} className={index + 1 === result.line ? 'link-preview-selected' : undefined}>
          <span className="link-preview-number">{index + 1}</span>{line || '\n'}
        </div>
      ))}</pre>}
    </div>
  </div>;
}

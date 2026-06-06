interface AttachmentFile { path: string; displayPath: string }

interface Props {
  images: string[];
  files: AttachmentFile[];
  onRemoveImage: (index: number) => void;
  onRemoveFile: (path: string) => void;
}

/** Pending paste/drop attachment chips shown above the textarea. Rendered only
 *  when there's at least one image or file; the parent owns the pending state. */
export function AttachmentChips({ images, files, onRemoveImage, onRemoveFile }: Props) {
  return (
    <div className="agent-attachment-row">
      {images.map((url, i) => (
        <span key={`img-${i}`} className="agent-attachment-chip">
          img {i + 1} ({Math.round(url.length * 3 / 4 / 1024)} KB)
          <button
            type="button"
            className="agent-attachment-remove"
            onClick={() => onRemoveImage(i)}
          >×</button>
        </span>
      ))}
      {files.map((f) => (
        <span key={f.path} className="agent-attachment-chip">
          {f.displayPath}
          <button
            type="button"
            className="agent-attachment-remove"
            onClick={() => onRemoveFile(f.path)}
          >×</button>
        </span>
      ))}
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { backendAttachments, historyImagePreviews, type PendingImageAttachment } from './agent-send-attachments';
import type { AgentAttachment } from '@shared/types';

describe('agent send attachments', () => {
  it('keeps image preview data URLs out of backend attachments', () => {
    const files: AgentAttachment[] = [
      { kind: 'file', path: '/repo/.tmp/shelf/a.txt', displayPath: '.tmp/shelf/a.txt', name: 'a.txt', size: 1 },
    ];
    const images: PendingImageAttachment[] = [
      {
        previewUrl: 'data:image/png;base64,PREVIEW',
        attachment: {
          kind: 'image',
          path: '/repo/.tmp/shelf/a.png',
          displayPath: '.tmp/shelf/a.png',
          name: 'a.png',
          mimeType: 'image/png',
          size: 3,
        },
      },
    ];

    expect(historyImagePreviews(images)).toEqual(['data:image/png;base64,PREVIEW']);
    expect(backendAttachments(files, images)).toEqual([
      files[0],
      images[0].attachment,
    ]);
  });

  it('omits empty fields for send payloads', () => {
    expect(historyImagePreviews([])).toBeUndefined();
    expect(backendAttachments([], [])).toBeUndefined();
  });
});

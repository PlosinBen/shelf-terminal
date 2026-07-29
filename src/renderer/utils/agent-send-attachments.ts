import type { AgentAttachment, AgentImageAttachment } from '@shared/types';

export interface PendingImageAttachment {
  previewUrl: string;
  attachment: AgentImageAttachment;
}

export function historyImagePreviews(images: PendingImageAttachment[]): string[] | undefined {
  const previews = images.map((image) => image.previewUrl);
  return previews.length > 0 ? previews : undefined;
}

export function backendAttachments(
  files: AgentAttachment[],
  images: PendingImageAttachment[],
): AgentAttachment[] | undefined {
  const attachments = [
    ...files,
    ...images.map((image) => image.attachment),
  ];
  return attachments.length > 0 ? attachments : undefined;
}

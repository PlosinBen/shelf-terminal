import path from 'path';
import fs from 'fs';
import { protocol, net } from 'electron';
import { pathToFileURL } from 'url';
import { projectsRoot } from './project-storage';
import { log } from '@shared/logger';

// shelf-image://<projectId>/<filename> → <userData>/projects/<id>/images/<filename>
//
// Registered as a standard scheme (privileges set in main entry before
// app ready) so renderer <img src> can load these without web security
// hassles. Validated to reject path traversal.

export const SHELF_IMAGE_SCHEME = 'shelf-image';

export function registerNotesProtocol(): void {
  protocol.handle(SHELF_IMAGE_SCHEME, async (request) => {
    try {
      // Manual parse: shelf-image://<projectId>/<filename>
      const stripped = request.url.replace(/^shelf-image:\/\//, '');
      const slash = stripped.indexOf('/');
      const projectId = slash === -1 ? stripped : stripped.slice(0, slash);
      const filename = slash === -1 ? '' : stripped.slice(slash + 1);

      if (!isSafeSegment(projectId) || !isSafeSegment(filename)) {
        return new Response('forbidden', { status: 403 });
      }

      const filePath = path.join(projectsRoot(), projectId, 'images', filename);
      if (!fs.existsSync(filePath)) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      log.error('notes-protocol', 'request failed', err);
      return new Response('error', { status: 500 });
    }
  });
}

function isSafeSegment(s: string): boolean {
  if (!s) return false;
  if (s.includes('..')) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  return /^[\w.-]+$/.test(s);
}

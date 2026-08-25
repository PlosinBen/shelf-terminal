import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const asset = (name: string) => fs.readFileSync(
  path.join(process.cwd(), 'resources', 'external-url-launcher', name),
  'utf8',
);

describe('external URL launcher assets', () => {
  it('writes the POSIX base64url frame directly to /dev/tty', () => {
    const script = asset('shelf-browser');
    expect(script).toContain('6973;external-url;1;');
    expect(script).toContain('base64');
    expect(script).toContain("tr '/+' '_-'");
    expect(script).toContain('> /dev/tty');
  });

  it('writes the Windows base64url frame directly to CONOUT$', () => {
    const script = asset('shelf-browser.ps1');
    expect(script).toContain('6973;external-url;1;');
    expect(script).toContain('[Convert]::ToBase64String');
    expect(script).toContain("'CONOUT$'");
  });
});

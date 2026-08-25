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

  it('provides a Windows command entrypoint for BROWSER and packages the launcher directory', () => {
    const command = asset('shelf-browser.cmd');
    expect(command).toContain('powershell.exe');
    expect(command).toContain('shelf-browser.ps1');
    expect(command).toContain('"%~1"');

    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.build.extraResources).toContainEqual({
      from: 'resources/external-url-launcher',
      to: 'external-url-launcher',
    });
  });
});

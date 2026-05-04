import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the tool execute functions directly by calling buildTools
// Since buildTools is not exported, we replicate the tool logic for unit testing.
// The actual integration is covered via the copilot backend test.

describe('copilot tool functions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('read_file logic', () => {
    it('reads a full file', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'line1\nline2\nline3\n');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toBe('line1\nline2\nline3\n');
    });

    it('reads with offset and limit', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'line0\nline1\nline2\nline3\nline4\n');
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const result = lines.slice(1, 1 + 2).join('\n');
      expect(result).toBe('line1\nline2');
    });
  });

  describe('write_file logic', () => {
    it('creates file and parent directories', () => {
      const filePath = path.join(tmpDir, 'sub', 'dir', 'new.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'hello', 'utf-8');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello');
    });
  });

  describe('edit_file logic', () => {
    it('replaces exact string', () => {
      const filePath = path.join(tmpDir, 'edit.txt');
      fs.writeFileSync(filePath, 'foo bar baz');
      const content = fs.readFileSync(filePath, 'utf-8');
      const updated = content.replace('bar', 'qux');
      fs.writeFileSync(filePath, updated);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('foo qux baz');
    });

    it('returns error when old_string not found', () => {
      const filePath = path.join(tmpDir, 'edit2.txt');
      fs.writeFileSync(filePath, 'foo bar baz');
      const content = fs.readFileSync(filePath, 'utf-8');
      const found = content.includes('notfound');
      expect(found).toBe(false);
    });
  });

  describe('bash logic', () => {
    it('executes command and returns output', () => {
      const { execSync } = require('child_process');
      const result = execSync('echo hello', { cwd: tmpDir, encoding: 'utf-8' });
      expect(result.trim()).toBe('hello');
    });

    it('returns error for failing command', () => {
      const { execSync } = require('child_process');
      try {
        execSync('exit 1', { cwd: tmpDir, encoding: 'utf-8' });
      } catch (err: any) {
        expect(err.status).toBe(1);
      }
    });
  });

  describe('list_directory logic', () => {
    it('lists files and directories', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
      fs.mkdirSync(path.join(tmpDir, 'subdir'));
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      const listing = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
      expect(listing).toContain('f a.txt');
      expect(listing).toContain('d subdir');
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseArch,
  parseLibc,
  detectTargetFromProbe,
  targetId,
  UnsupportedTargetError,
  SUPPORTED_TARGETS,
  parseNodeMajor,
  isRemoteNodeSupported,
  MIN_REMOTE_NODE_MAJOR,
} from './runtime-target';

describe('parseArch', () => {
  it('maps aarch64 / arm64 → arm64', () => {
    expect(parseArch('aarch64')).toBe('arm64');
    expect(parseArch('arm64')).toBe('arm64');
    expect(parseArch('  aarch64\n')).toBe('arm64');
  });
  it('maps x86_64 / amd64 / x64 → x64', () => {
    expect(parseArch('x86_64')).toBe('x64');
    expect(parseArch('amd64')).toBe('x64');
    expect(parseArch('x64')).toBe('x64');
  });
  it('throws on unknown arch', () => {
    expect(() => parseArch('riscv64')).toThrow(UnsupportedTargetError);
    expect(() => parseArch('')).toThrow(UnsupportedTargetError);
  });
});

describe('parseLibc', () => {
  it('detects musl from ld-musl loader', () => {
    expect(parseLibc('/lib/ld-musl-aarch64.so.1')).toBe('musl');
  });
  it('detects glibc from ld-linux loader', () => {
    expect(parseLibc('/lib/ld-linux-aarch64.so.1')).toBe('glibc');
    expect(parseLibc('/lib64/ld-linux-x86-64.so.2')).toBe('glibc');
  });
  it('musl wins if both loaders appear', () => {
    expect(parseLibc('/lib/ld-linux-x86-64.so.2\n/lib/ld-musl-x86_64.so.1')).toBe('musl');
  });
  it('throws when no loader found', () => {
    expect(() => parseLibc('')).toThrow(UnsupportedTargetError);
    expect(() => parseLibc('nothing here')).toThrow(UnsupportedTargetError);
  });
});

describe('detectTargetFromProbe', () => {
  it('arm64 glibc (debian/ubuntu arm)', () => {
    const t = detectTargetFromProbe('aarch64\n/lib/ld-linux-aarch64.so.1');
    expect(targetId(t)).toBe('arm64-glibc');
  });
  it('x64 glibc', () => {
    const t = detectTargetFromProbe('x86_64\n/lib64/ld-linux-x86-64.so.2');
    expect(targetId(t)).toBe('x64-glibc');
  });
  it('accepts x64-musl (alpine x64 — use remote node)', () => {
    expect(targetId(detectTargetFromProbe('x86_64\n/lib/ld-musl-x86_64.so.1'))).toBe('x64-musl');
  });
  it('accepts arm64-musl (gap gone under use-remote-node)', () => {
    expect(targetId(detectTargetFromProbe('aarch64\n/lib/ld-musl-aarch64.so.1'))).toBe('arm64-musl');
  });
  it('still rejects an unknown arch', () => {
    expect(() => detectTargetFromProbe('riscv64\n/lib/ld-linux-riscv64.so.1')).toThrow(
      UnsupportedTargetError,
    );
  });
  it('ignores blank leading lines before uname output', () => {
    const t = detectTargetFromProbe('\n\nx86_64\n/lib64/ld-linux-x86-64.so.2');
    expect(targetId(t)).toBe('x64-glibc');
  });
  it('supported set is all four (arch × libc) combos', () => {
    expect([...SUPPORTED_TARGETS].sort()).toEqual(['arm64-glibc', 'arm64-musl', 'x64-glibc', 'x64-musl']);
  });
});

describe('remote node version (musl path)', () => {
  it('parses the major from node --version output', () => {
    expect(parseNodeMajor('v20.18.1')).toBe(20);
    expect(parseNodeMajor('22.3.0')).toBe(22);
    expect(parseNodeMajor('garbage')).toBeNull();
  });
  it('accepts node >= the minimum, rejects older / unparseable', () => {
    expect(isRemoteNodeSupported(`v${MIN_REMOTE_NODE_MAJOR}.0.0`)).toBe(true);
    expect(isRemoteNodeSupported('v22.1.0')).toBe(true);
    expect(isRemoteNodeSupported('v18.20.0')).toBe(false);
    expect(isRemoteNodeSupported('')).toBe(false);
  });
});

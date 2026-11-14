import { describe, expect, it } from 'vitest';
import { compareCodexVersions } from '../src/shared/codex-runtime.js';

describe('Codex semantic version ordering', () => {
  it.each([
    ['0.163.0-alpha.11.2', '0.163.0'],
    ['0.163.0', '0.164.0-alpha.11.1'],
    ['0.164.0-alpha.11.1', '0.165.0-alpha.1.2'],
    ['0.165.0-alpha.1.2', '0.166.0-alpha.5.1'],
    ['0.166.0-alpha.5.1', '0.166.0-alpha.6'],
    ['0.166.0-alpha.6', '0.167.0-alpha.3.2'],
    ['0.167.0-alpha.4.1', '0.169.0-alpha.11.1'],
    ['0.165.0-alpha.2', '0.165.0-alpha.11'],
    ['0.165.0-alpha.11', '0.165.0-alpha.11.2'],
    ['0.165.0-1', '0.165.0-alpha'],
  ])('orders %s before %s', (older, newer) => {
    expect(compareCodexVersions(older, newer)).toBeLessThan(0);
    expect(compareCodexVersions(newer, older)).toBeGreaterThan(0);
  });

  it('ignores build metadata when selecting a version', () => {
    expect(compareCodexVersions('0.165.0-alpha.1.2+first', '0.165.0-alpha.1.2+second')).toBe(0);
  });
});

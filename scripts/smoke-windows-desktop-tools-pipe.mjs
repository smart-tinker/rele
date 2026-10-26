import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCSharpCompiler } from './build-process-host.mjs';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Use only an isolated Windows fixture.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'Rele Desktop pipe '));
try {
  const executable = path.join(temporary, 'DesktopToolsPipeFixture.exe');
  const compiled = spawnSync(await findCSharpCompiler(), ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${executable}`,
    path.join(root, 'scripts/windows/DesktopToolsPipe.cs'), path.join(root, 'scripts/windows/DesktopToolsPipeFixture.cs')],
  { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (compiled.error) throw compiled.error;
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.result, 'passed');
  assert.ok(receipt.checks >= 20);
  console.log(JSON.stringify(receipt));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

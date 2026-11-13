import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.skipIf(!process.env.RELE_NATIVE_GOALS_CLI)('checks native Goal creation, pause, restart, continuation and completion with only a loopback provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rele-native-goals-')); directories.push(directory);
  const expectedVersion = process.env.RELE_NATIVE_GOALS_VERSION ?? '0.167.0-alpha.4.1';
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/probe-native-goals.mjs', '--executable', process.env.RELE_NATIVE_GOALS_CLI!, '--expected-version', expectedVersion, '--directory', directory],
    { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    version: expectedVersion, isolatedHome: true, provider: 'loopback-fixture', paidInferenceRequests: 0,
    goalCreated: true, goalReadBack: true, ordinaryTurnsSubmitted: 0,
    pause: { persisted: true, noFurtherContinuation: true, activeTurnInterruptedByPause: false },
    restart: { sameGoal: true, remainsPaused: true, didNotRunModel: true },
    completion: { nativeComplete: true, finalTurnCompleted: true, unpausedStageAccounted: true },
    approval: { requested: true, declined: true, noCommandExecution: true },
  });
  expect(result.goalTurnNotifications).toBeGreaterThan(0);
  expect(result.turns.length).toBeGreaterThanOrEqual(3);
  expect(result.turns.every((turn: { goalField: boolean }) => turn.goalField === false)).toBe(true);
  expect(result.approval.goalAttributionBeforeRequest).toBeTypeOf('boolean');
  expect(result.approval.goalAttributionBeforeDecline).toBeTypeOf('boolean');
}, 65_000);

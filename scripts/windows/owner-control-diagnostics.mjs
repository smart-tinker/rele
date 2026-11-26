import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const phases = new Set(['preflight', 'status-missing', 'start-initial', 'status-live', 'native-initialize',
  'legacy-task-fixture', 'start-repair-active', 'stage-gui-successor', 'reject-unknown-successor-action',
  'status-before-native-crash', 'crash-own-native', 'wait-task-recovery', 'promote-cold-successor',
  'verify-recovered-native', 'cleanup-after-recovery', 'status-after-stop', 'foreign-port-refusal',
  'cleanup-final', 'unknown']);
const types = new Map([['AssertionError', 'assertion'], ['Error', 'error'], ['TypeError', 'type'],
  ['RangeError', 'range'], ['ReferenceError', 'reference'], ['SyntaxError', 'syntax'],
  ['TimeoutError', 'timeout'], ['AggregateError', 'aggregate']]);
const pattern = new RegExp('^RELE_CI_OWNER_CONTROL_FAILURE phase=(' + [...phases].join('|') +
  ') errorType=(' + [...new Set([...types.values(), 'other'])].join('|') + ') cleanup=(passed|unconfirmed)$', 'u');

export function formatOwnerControlFailure({ phase, error, cleanupConfirmed }) {
  const safePhase = phases.has(phase) ? phase : 'unknown';
  const errorType = types.get(error?.name) || 'other';
  return `RELE_CI_OWNER_CONTROL_FAILURE phase=${safePhase} errorType=${errorType} cleanup=${cleanupConfirmed === true ? 'passed' : 'unconfirmed'}`;
}

export function parseOwnerControlFailureOutput(output) {
  if (typeof output !== 'string') return undefined;
  for (const line of output.split(/\r?\n/u).reverse()) {
    const match = pattern.exec(line);
    if (match) return { phase: match[1], errorType: match[2], cleanup: match[3] };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failure = parseOwnerControlFailureOutput(readFileSync(process.argv[2], 'utf8'));
    if (failure) process.stdout.write(JSON.stringify(failure));
  } catch { process.exitCode = 1; }
}

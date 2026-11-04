export const SUPPORTED_CODEX_VERSION = '0.163.0';
export const SUPPORTED_CODEX_VERSIONS: readonly string[] = [SUPPORTED_CODEX_VERSION, '0.163.0-alpha.10.2', '0.163.0-alpha.11', '0.163.0-alpha.11.2', '0.164.0-alpha.11.1', '0.165.0-alpha.1.2', '0.166.0-alpha.5.1', '0.166.0-alpha.6'];

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function compareCodexVersions(left: string, right: string): number {
  const a = versionPattern.exec(left)!, b = versionPattern.exec(right)!;
  for (let index = 1; index <= 3; index++) if (Number(a[index]) !== Number(b[index])) return Number(a[index]) - Number(b[index]);
  if (a[4] === b[4]) return 0;
  if (!a[4] || !b[4]) return a[4] ? -1 : 1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === y[index]) continue;
    if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
    const numericX = /^\d+$/u.test(x[index]), numericY = /^\d+$/u.test(y[index]);
    if (numericX && numericY) return Number(x[index]) - Number(y[index]);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}

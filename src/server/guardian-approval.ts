export const GUARDIAN_APPROVAL_CODEX_VERSION = '0.166.0-alpha.6';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,160}$/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const visible = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && !/[\p{C}\p{Default_Ignorable_Code_Point}]|[^\S ]/u.test(value);

export interface GuardianDenial {
  threadId: string;
  turnId: string;
  reviewId: string;
  completedAtMs: number;
  preview: string;
  event: Record<string, unknown>;
}

/** Convert the alpha.6 v2 notification to the core event expected by the approval RPC. */
export function parseGuardianDenial(params: unknown): GuardianDenial | undefined {
  const data = record(params);
  if (!data) return;
  const { threadId, turnId, reviewId, startedAtMs, completedAtMs, targetItemId, decisionSource } = data;
  if (!id(threadId) || !id(turnId) || !id(reviewId) || !(targetItemId === null || id(targetItemId))
    || !timestamp(startedAtMs) || !timestamp(completedAtMs) || completedAtMs < startedAtMs || decisionSource !== 'agent') return;
  const review = record(data.review), action = record(data.action);
  if (!review || review.status !== 'denied' || !action) return;
  const { riskLevel, userAuthorization, rationale } = review;
  if (riskLevel !== 'low' && riskLevel !== 'medium' && riskLevel !== 'high') return;
  if (userAuthorization !== null && userAuthorization !== 'unknown' && userAuthorization !== 'low'
    && userAuthorization !== 'medium' && userAuthorization !== 'high') return;
  if (rationale !== null && (typeof rationale !== 'string' || rationale.length > 4096)) return;

  const { type, cwd } = action;
  const source = action.source === 'shell' ? 'shell' : action.source === 'unifiedExec' ? 'unified_exec' : undefined;
  if (!source || !visible(cwd, 768) || !/^\/(?!\/)|^[A-Za-z]:[\\/]/u.test(cwd) || cwd.trim() !== cwd) return;
  let nativeAction: Record<string, unknown>, commandPreview: string;
  if (type === 'command') {
    const { command } = action;
    if (Object.keys(action).length !== 4 || !visible(command, 1500) || !command || command.trim() !== command) return;
    nativeAction = { type, source, command, cwd };
    commandPreview = `Команда: ${command}`;
  } else if (type === 'execve') {
    const { program, argv } = action;
    if (Object.keys(action).length !== 5 || !visible(program, 768) || !program || program.trim() !== program || !Array.isArray(argv) || argv.length > 64
      || !Array.from(argv).every(arg => visible(arg, 1500))) return;
    nativeAction = { type, source, program, argv: [...argv], cwd };
    commandPreview = `Программа: ${JSON.stringify(program)}\nАргументы: ${JSON.stringify(argv)}`;
  } else return;

  const preview = `Запуск: ${source === 'shell' ? 'оболочка' : 'терминал Codex'}\nКаталог: ${cwd}\n${commandPreview}`;
  if (preview.length > 1800) return;
  return { threadId, turnId, reviewId, completedAtMs, preview, event: {
    id: reviewId, turn_id: turnId, started_at_ms: startedAtMs, completed_at_ms: completedAtMs,
    status: 'denied', risk_level: riskLevel, decision_source: decisionSource, action: nativeAction,
    ...(targetItemId === null ? {} : { target_item_id: targetItemId }),
    ...(userAuthorization === null ? {} : { user_authorization: userAuthorization }),
    ...(rationale === null ? {} : { rationale }),
  } };
}

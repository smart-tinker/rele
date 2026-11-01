import { splitReply, type RequestProgress } from './common.js';

const titles = {
  completed: 'Завершено', failed: 'Ошибка выполнения', interrupted: 'Остановлено в Codex', cancelled: 'Отменено',
};

export function slackProgressPages(progress: RequestProgress): string[] {
  const text = progress.steps?.map(step => step.text).join('\n\n') || progress.commentary || '';
  return text.trim() ? splitReply(text, 6000) : [];
}

export function slackPageControls(requestId: string, kind: 'history' | 'answer', page: number, count: number, segment?: string): Record<string, unknown>[] {
  if (count < 2) return [];
  return [
    { type: 'context', elements: [{ type: 'plain_text', text: `${kind === 'history' ? 'Ход работы' : 'Результат'}: часть ${page + 1} из ${count}` }] },
    { type: 'actions', elements: [page > 0 ? page - 1 : undefined, page + 1 < count ? page + 1 : undefined]
      .filter((target): target is number => target !== undefined).map(target => ({
        type: 'button', action_id: `rele_progress_${kind}_${target < page ? 'prev' : 'next'}`,
        text: { type: 'plain_text', text: target < page ? '← Назад' : 'Далее →' },
        value: `relep:${requestId}:${segment ? `${segment}:` : ''}${kind}:${target}`,
      })) },
  ];
}

/** Public commentary and plan only. Rich text keeps quoted mentions inert. */
export function slackProgressBlocks(requestId: string, progress: RequestProgress, historyPage?: number, segment?: string): Record<string, unknown>[] {
  const pages = slackProgressPages(progress);
  const page = Math.min(historyPage ?? pages.length - 1, Math.max(0, pages.length - 1));
  const text = pages[page];
  const status = progress.terminal === 'completed' ? 'complete' : progress.terminal ? 'error' : 'in_progress';
  const nativeId = segment && segment !== '0' ? `${requestId}:segment:${segment}` : requestId;
  const stageTitle = segment !== undefined && progress.terminal === 'completed' ? 'Этап завершён' : undefined;
  const blocks: Record<string, unknown>[] = [{
    type: 'task_card', task_id: `${nativeId}:progress`,
    title: stageTitle ?? (progress.terminal ? titles[progress.terminal] : progress.statusText || 'Выполняется'), status,
    ...(text ? { details: {
      type: 'rich_text', elements: [{ type: 'rich_text_section', elements: splitReply(text, 1450).map(text => ({ type: 'text', text })) }],
    } } : {}),
  }];
  if (progress.plan?.length) blocks.push({
    type: 'plan', title: 'План работы',
    // Slack's long-task example explicitly supports pending in grouped plans:
    // https://docs.slack.dev/ai/developing-agents/#handling-long-running-tasks
    tasks: progress.plan.map((item, index) => ({
      task_id: `${nativeId}:step:${index}`, title: item.step,
      status: item.status === 'completed' ? 'complete'
        : progress.terminal && progress.terminal !== 'completed' && item.status === 'in_progress' ? 'error' : item.status,
    })),
  });
  blocks.push(...slackPageControls(requestId, 'history', page, pages.length, segment));
  return blocks;
}

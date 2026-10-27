import type { RequestProgress } from './common.js';

const titles = {
  completed: 'Завершено', failed: 'Ошибка выполнения', interrupted: 'Остановлено в Codex', cancelled: 'Отменено',
};

/** Public commentary and plan only. Rich text keeps quoted mentions inert. */
export function slackProgressBlocks(requestId: string, progress: RequestProgress): Record<string, unknown>[] {
  const status = progress.terminal === 'completed' ? 'complete' : progress.terminal ? 'error' : 'in_progress';
  const blocks: Record<string, unknown>[] = [{
    type: 'task_card', task_id: `${requestId}:progress`,
    title: progress.terminal ? titles[progress.terminal] : 'Выполняется', status,
    ...(progress.commentary?.trim() ? { details: {
      type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: progress.commentary }] }],
    } } : {}),
  }];
  if (progress.plan?.length) blocks.push({
    type: 'plan', title: 'План работы',
    // Slack's long-task example explicitly supports pending in grouped plans:
    // https://docs.slack.dev/ai/developing-agents/#handling-long-running-tasks
    tasks: progress.plan.map((item, index) => ({
      task_id: `${requestId}:step:${index}`, title: item.step,
      status: item.status === 'completed' ? 'complete'
        : progress.terminal && progress.terminal !== 'completed' && item.status === 'in_progress' ? 'error' : item.status,
    })),
  });
  return blocks;
}

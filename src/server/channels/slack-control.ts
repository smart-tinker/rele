import type { ControlContext, ControlInput, ControlSelection, ControlView } from '../source-control.js';
import { splitReply } from './common.js';

export const CONTROL_VIEW = 'rele_source_control';
export const CONTROL_SHORTCUT = 'rele_manage';
export interface ControlCommand { kind: 'open' | 'preview' | 'submit'; id?: string; action?: ControlSelection; input?: ControlInput }
const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 2900) });
const section = (text: string) => ({ type: 'section', text: { type: 'plain_text', text } });
const boundedBlocks = (blocks: Record<string, any>[]) => blocks.flatMap(block => block.type === 'section'
  ? splitReply(block.text.text, 1450).map(section) : [block]);
const option = (label: string, value: string) => ({ text: plain(label.slice(0, 75)), value });
const actions = [['Статус', 'status'], ['Цель', 'goal'], ['Остановить цель', 'stop'], ['Модель', 'model']] as const;
export function controlMessage(message: string): Record<string, unknown> {
  return { type: 'modal', callback_id: CONTROL_VIEW, title: plain('Управление Rele'), close: plain('Закрыть'), blocks: boundedBlocks([section(message)]) };
}
export function controlMetadata(raw: unknown): { id: string; context: ControlContext } {
  if (typeof raw !== 'string' || raw.length > 3000) throw new Error('Форма управления недоступна.');
  const data = JSON.parse(raw);
  if (!data || !/^[a-f0-9-]{36}$/u.test(data.id) || !data.context || ['accountId', 'chatId', 'threadId', 'messageId', 'senderId', 'senderName'].some(field => typeof data.context[field] !== 'string')
    || data.context.senderIsBot !== false) throw new Error('Форма управления недоступна.');
  return data;
}
export function controlInput(values: Record<string, any>): ControlInput {
  const action = values?.operation?.action?.selected_option?.value;
  if (!actions.some(([, value]) => value === action)) throw new Error('Выберите действие управления.');
  if (action === 'model') return { action, model: values.model?.model?.selected_option?.value, effort: values.effort?.effort?.selected_option?.value };
  if (action === 'goal') {
    const raw = values.budget?.budget?.value;
    if (raw && (typeof raw !== 'string' || !/^[1-9]\d{0,12}$/u.test(raw))) throw new Error('Укажите положительный целый бюджет токенов или оставьте поле пустым.');
    return { action, objective: values.objective?.objective?.value, criterion: values.criterion?.criterion?.value, ...(raw ? { tokenBudget: Number(raw) } : {}) };
  }
  return { action };
}
export function controlModal(view: ControlView, context: ControlContext, selectedModel?: string, selectedEffort?: string): Record<string, unknown> {
  const snapshot = view.snapshot;
  const blocks: Record<string, unknown>[] = [section(`${view.sourceTitle}\nCodex: ${view.conversationTitle}\nID: ${view.nativeThreadId}\nДоступ источника: ${view.accessMode ?? 'неизвестен'}.`)];
  if (view.message) blocks.push(section(view.message));
  if (view.finished) return { ...controlMessage(view.message ?? 'Операция обработана.'), blocks: boundedBlocks(blocks) };
  const selected = actions.find(([, value]) => value === view.action)!;
  blocks.push({ type: 'input', block_id: 'operation', dispatch_action: true, label: plain('Действие'), element: { type: 'static_select', action_id: 'action',
    options: actions.map(([label, value]) => option(label, value)), initial_option: option(selected[0], selected[1]) } });
  blocks.push(section(!view.connected || !snapshot ? 'Codex отключён. Текущее состояние неизвестно; сохранённые данные не считаются свежими.'
    : `Подключение Codex: доступно; разговор: ${snapshot.runtimeStatus}.\n${snapshot.runtimeStatus === 'notLoaded' ? 'Сохранённая' : 'Настроенная'} модель: ${snapshot.model ?? 'неизвестна'}; глубина: ${snapshot.effort ?? 'неизвестна'}.\nФактическая модель и глубина текущего хода не подтверждены.\nЗапросы этого Slack-треда: в очереди ${view.ownQueued}, активны ${view.ownRunning}.\nЦель: ${snapshot.goal?.status ?? (snapshot.goalSupported ? 'не задана' : 'поддержка не подтверждена')}.\nДоставка этапов по квитанциям Rele: ${view.goalDeliveryState ?? 'не отслеживается этим источником'}.`));
  let submit: string | undefined = 'Обновить';
  if (view.action === 'model') {
    blocks.push(section(`Изменится общий Codex-чат для последующих запросов всех связанных источников (${view.boundSources}). Текущий ход сохранит свои настройки. Каталог не подтверждает доступ провайдера; платный проверочный запрос не запускается.`));
    const models = view.models?.slice(0, 100) ?? [], model = models.find(row => row.model === (selectedModel ?? snapshot?.model));
    if (models.length) blocks.push({ type: 'input', block_id: 'model', dispatch_action: true, label: plain('Модель'), element: { type: 'static_select', action_id: 'model', placeholder: plain('Выберите модель'),
      options: models.map(row => option(row.displayName, row.model)), ...(model ? { initial_option: option(model.displayName, model.model) } : {}) } });
    if (model) {
      const effort = model.efforts.includes(selectedEffort ?? '') ? selectedEffort! : model.efforts.includes(snapshot?.effort ?? '') ? snapshot!.effort! : model.defaultEffort;
      blocks.push({ type: 'input', block_id: 'effort', label: plain('Глубина рассуждения'), element: { type: 'static_select', action_id: 'effort',
        options: model.efforts.map(effort => option(effort, effort)), initial_option: option(effort, effort) } });
    }
    if (!view.connected || !models.length || !model) submit = undefined; else submit = 'Сохранить';
  } else if (view.action === 'goal') {
    if (snapshot?.goal && snapshot.goal.status !== 'complete') {
      blocks.push(section(`В разговоре уже есть цель. Новая цель её не заменит.\n${snapshot.goal.objective}\nТокены: ${snapshot.goal.tokensUsed}${snapshot.goal.tokenBudget === null ? ' (без заданного лимита)' : ` / ${snapshot.goal.tokenBudget}`}; время: ${snapshot.goal.timeUsedSeconds} с.`)); submit = undefined;
    } else if (view.goalLaunchUnavailable) { blocks.push(section(view.goalLaunchUnavailable)); submit = undefined; }
    else if (!snapshot?.goalSupported) { blocks.push(section('Native Goals API не подтверждён для подключённого Codex. Цель не будет имитироваться обычным запросом.')); submit = undefined; }
    else {
      for (const [id, label] of [['objective', 'Цель'], ['criterion', 'Критерий завершения']] as const) blocks.push({ type: 'input', block_id: id, label: plain(label), element: { type: 'plain_text_input', action_id: id, multiline: true, max_length: 3000 } });
      blocks.push({ type: 'input', block_id: 'budget', optional: true, label: plain('Лимит токенов (необязательно)'), element: { type: 'plain_text_input', action_id: 'budget', max_length: 13 } });
      blocks.push(section('Цель и критерий вместе: до 4000 символов. Пустой лимит означает отсутствие заданного лимита токенов. Лимит времени не задаётся. Отправка формы создаст одну native цель в указанном разговоре. Подтверждённые результаты придут в этот Slack-тред. Некоторые вопросы и подтверждения нужно завершить в приложении Codex; следите за native UI во время цели.'));
      submit = 'Создать цель';
    }
  } else if (view.action === 'stop') {
    blocks.push(section(snapshot?.goal ? `Цель: ${snapshot.goal.objective}\nБудет запрошена native приостановка цели и остановка её подтверждённого текущего хода. Обычные запросы других ходов сохраняются.` : 'Действующей цели нет.'));
    submit = snapshot?.goalSupported && snapshot.goal ? 'Остановить цель' : undefined;
  }
  return { type: 'modal', callback_id: CONTROL_VIEW, title: plain('Управление Rele'), close: plain('Закрыть'), notify_on_close: true,
    private_metadata: JSON.stringify({ id: view.id, context }), blocks: boundedBlocks(blocks), ...(submit ? { submit: plain(submit) } : {}) };
}

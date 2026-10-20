import { useState, type FormEvent } from 'react';
import type { AutoLinkRule, CatalogChat, DashboardState, Endpoint, Platform } from '../shared/types';
import { ReleApi } from './client';
import { useAction } from './hooks';
import { AllowedSenders, CatalogControls, useCatalog } from './CatalogPicker';
import { ActionMessages, Button, Drawer, Field, Notice, PlatformIcon, Status } from './ui';

const platformName = (platform: Platform) => platform === 'slack' ? 'Slack' : 'Telegram';
const intentNames = { pending: 'Ожидает создания', creating: 'Создаётся', created: 'Тред создан', uncertain: 'Нужно проверить', failed: 'Ошибка', completed: 'Связка создана' };

export function AutoLinks({ state, api, refresh }: { state: DashboardState; api: ReleApi; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<AutoLinkRule | 'new' | null>(null);
  const action = useAction();
  const rules = state.config.autoLinkRules ?? [];
  const chats = useCatalog<CatalogChat>(api, state.connections.slack.connected && rules.some(rule => rule.platform === 'slack') ? '/api/catalog/slack/chats' : undefined);
  const saveRules = async (next: AutoLinkRule[], message: string) => {
    const result = await action.run(() => api.request('/api/config', 'PUT', { autoLinkRules: next }), message);
    if (result.ok) await refresh();
    return result.ok;
  };
  const chatName = (rule: AutoLinkRule) => state.endpoints.find(endpoint => endpoint.platform === rule.platform && endpoint.accountId === rule.accountId && endpoint.chatId === rule.chatId)?.chatTitle
    || state.endpoints.find(endpoint => endpoint.platform === rule.platform && endpoint.accountId === rule.accountId && endpoint.chatId === rule.chatId)?.title
    || (rule.platform === 'slack' ? chats.items.find(chat => chat.id === rule.chatId)?.name : undefined)
    || `${platformName(rule.platform)} · выбранный чат`;
  return <section className="settings-section" aria-labelledby="auto-links-title">
    <div className="settings-heading"><h2 id="auto-links-title">Новые разговоры из мессенджера</h2><Button onClick={() => setEditing('new')}>Добавить правило</Button></div>
    <p className="muted">Явно разрешите автосоздание для выбранного канала или чата. Первый разрешённый запрос в новом обсуждении создаст отдельный разговор Codex и связку. Существующие связки продолжают использовать свой разговор.</p>
    {!rules.length && <p className="field-hint">Автосоздание выключено: разрешённых чатов пока нет.</p>}
    {rules.map(rule => <div className="form-section" key={rule.id}>
      <div className="inline-controls"><PlatformIcon platform={rule.platform} /><strong>{chatName(rule)}</strong><Status tone={rule.enabled ? 'good' : 'muted'}>{rule.enabled ? 'Включено' : 'Выключено'}</Status></div>
      <p className="field-hint">{rule.cwd} · {rule.allowAllSenders ? 'Все участники, включая агентов' : `Отправителей: ${rule.allowedSenderIds.length}`} · {rule.requireMention ? 'В группах — по упоминанию' : 'В группах — любое сообщение'}</p>
      {state.connections[rule.platform].accountId !== rule.accountId && <Notice tone="warning">Правило относится к другому боту. Выберите текущий чат и отправителей заново.</Notice>}
      <div className="form-actions"><Button disabled={action.busy} onClick={() => setEditing(rule)}>Изменить правило</Button><Button disabled={action.busy} onClick={() => void saveRules(rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item), rule.enabled ? 'Автосоздание выключено.' : 'Автосоздание включено.')}>{rule.enabled ? 'Выключить правило' : 'Включить правило'}</Button><Button variant="danger" disabled={action.busy} onClick={() => void saveRules(rules.filter(item => item.id !== rule.id), 'Правило удалено. Созданные связки сохранены.')}>Удалить правило</Button></div>
    </div>)}
    <p className="field-hint">Правило охватывает все новые треды Slack или темы Telegram в выбранном чате. В личных сообщениях допускаются только разрешённые люди. Отключение и удаление правила сохраняет уже созданные связки.</p>
    <ActionMessages error={action.error} success={action.success} />
    {!!state.autoLinks?.length && <div className="form-stack" aria-label="Журнал автосоздания"><h3>Автосоздание разговоров</h3>{state.autoLinks.map(intent => <div className="form-section" key={intent.id}>
      <div className="inline-controls"><strong>{chatName(intent.rule)}</strong><Status tone={intent.status === 'uncertain' || intent.status === 'failed' ? 'warning' : intent.status === 'completed' ? 'good' : 'muted'}>{intentNames[intent.status]}</Status></div>
      {intent.error && <Notice tone="warning">{intent.error}</Notice>}
      {intent.threadId && <p className="field-hint">Созданный разговор Codex: <code>{intent.threadId}</code></p>}
      {(intent.status === 'uncertain' || intent.status === 'failed') && <p className="field-hint">Проверьте список разговоров Codex. Если разговор уже создан, свяжите его с исходным обсуждением через «Связки». Повторное создание автоматически не выполняется.</p>}
    </div>)}</div>}
    {editing && <Drawer title={editing === 'new' ? 'Новое правило автосоздания' : 'Правило автосоздания'} onClose={() => setEditing(null)}>
      <AutoLinkForm key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? undefined : editing} state={state} api={api} refresh={refresh}
        onSave={async rule => { const latest = state.config.autoLinkRules ?? []; const next = latest.some(item => item.id === rule.id) ? latest.map(item => item.id === rule.id ? rule : item) : [...latest, rule]; const result = await api.request('/api/config', 'PUT', { autoLinkRules: next }); await refresh(); setEditing(null); return result; }} />
    </Drawer>}
  </section>;
}

function AutoLinkForm({ rule, state, api, refresh, onSave }: { rule?: AutoLinkRule; state: DashboardState; api: ReleApi; refresh: () => Promise<void>; onSave: (rule: AutoLinkRule) => Promise<unknown> }) {
  const [value, setValue] = useState<AutoLinkRule>(() => rule ?? { id: crypto.randomUUID(), enabled: false, platform: 'slack', accountId: state.connections.slack.accountId ?? '', chatId: '', cwd: '', allowedSenderIds: [], requireMention: true });
  const action = useAction();
  const accountId = state.connections[value.platform].accountId;
  const known = state.endpoints.filter(endpoint => endpoint.platform === value.platform && endpoint.accountId === accountId && endpoint.available !== false);
  const chats = useCatalog<CatalogChat>(api, value.platform === 'slack' ? '/api/catalog/slack/chats' : undefined);
  const choices = [...new Map([...known.map(endpoint => ({ id: endpoint.chatId, name: endpoint.chatTitle || endpoint.title, kind: (value.platform === 'slack' ? endpoint.chatId.startsWith('D') : /^\d+$/u.test(endpoint.chatId)) ? 'direct' as const : 'group' as const })), ...chats.items].map(chat => [chat.id, chat])).values()];
  const inChat = known.filter(endpoint => endpoint.chatId === value.chatId);
  const people = [...new Map(inChat.flatMap(endpoint => endpoint.people).map(person => [person.id, person])).values()];
  const endpoint: Endpoint = { id: `auto-rule-${value.id}`, platform: value.platform, accountId: value.accountId, chatId: value.chatId, threadId: '', title: choices.find(chat => chat.id === value.chatId)?.name ?? 'Выбранный чат', subtitle: '', people, updatedAt: '' };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.chatId || !value.cwd.trim() || (!value.allowAllSenders && !value.allowedSenderIds.length)) { action.setError('Выберите чат, рабочую папку и разрешённых людей для личного чата.'); return; }
    await action.run(() => onSave({ ...value, cwd: value.cwd.trim() }));
  };
  return <form className="form-stack" onSubmit={submit}>
    <Notice tone="info">Новые обсуждения получат новый разговор Codex. Профиль, модель и политики берутся из текущего подключения Codex.</Notice>
    <Field label="Мессенджер правила"><select value={value.platform} disabled={action.busy} onChange={event => { const platform = event.target.value as Platform; setValue(current => ({ ...current, platform, accountId: state.connections[platform].accountId ?? '', chatId: '', allowedSenderIds: [], allowAllSenders: false })); }}><option value="slack">Slack</option><option value="telegram">Telegram</option></select></Field>
    <Field label="Чат для новых разговоров" hint="Все новые треды или темы выбранного канала/чата."><select value={value.chatId} disabled={action.busy} onChange={event => setValue(current => ({ ...current, accountId: accountId ?? '', chatId: event.target.value, allowedSenderIds: [], allowAllSenders: choices.find(chat => chat.id === event.target.value)?.kind !== 'direct' }))}><option value="">Выберите чат по названию</option>{value.chatId && !choices.some(chat => chat.id === value.chatId) && <option value={value.chatId}>Сохранённый чат недоступен</option>}{choices.map(chat => <option key={chat.id} value={chat.id}>{chat.name}</option>)}</select></Field>
    {value.platform === 'slack' && <CatalogControls catalog={chats} label="чаты для автосоздания" disabled={action.busy} />}
    {value.platform === 'telegram' && <p className="field-hint">Если чата нет, отправьте в нём /rele_register и обновите панель. Регистрация не запускает Codex.</p>}
    <Field label="Рабочая папка новых разговоров" hint="Абсолютный локальный путь на компьютере, где работает Codex."><input value={value.cwd} maxLength={4096} required disabled={action.busy} onChange={event => setValue(current => ({ ...current, cwd: event.target.value }))} placeholder="Например, C:\\Projects\\app или /srv/projects/app" /></Field>
    {!!value.chatId && value.allowAllSenders && <Notice tone="info">Все участники выбранной группы или канала, включая агентов, получают право запускать Codex. Отдельный список отправителей не требуется.</Notice>}
    {!!value.chatId && !value.allowAllSenders && <AllowedSenders key={`${value.platform}:${value.accountId}:${value.chatId}`} endpoint={endpoint} accountId={accountId} wholeChat humansOnly api={api} refresh={refresh} value={value.allowedSenderIds} onChange={allowedSenderIds => setValue(current => ({ ...current, allowedSenderIds }))} disabled={action.busy} />}
    <label className="check-row"><input type="checkbox" checked={value.requireMention} disabled={action.busy} onChange={event => setValue(current => ({ ...current, requireMention: event.target.checked }))} /><span>В группах создавать разговор только при упоминании подключённого агента</span></label>
    <p className="field-hint">Без галочки в группе подходит любое сообщение, в том числе от другого агента. В личных чатах допускаются только выбранные люди.</p>
    <label className="check-row"><input type="checkbox" checked={value.enabled} disabled={action.busy} onChange={event => setValue(current => ({ ...current, enabled: event.target.checked }))} /><span>Разрешить автоматическое создание новых разговоров в этом чате</span></label>
    <ActionMessages error={action.error} success={action.success} /><div><Button type="submit" variant="primary" busy={action.busy}>Сохранить правило</Button></div>
  </form>;
}

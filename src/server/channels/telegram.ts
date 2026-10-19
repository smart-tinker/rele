import { setTimeout as delay } from 'node:timers/promises';
import type { Approval, AudioAttachment, ConnectionState, Delivery, Endpoint, InboundMessage, Person } from '../../shared/types.js';
import { ChannelError, downloadBounded, endpointId, readableTitle, type Channel, type ChannelCallbacks } from './common.js';

type ObjectValue = Record<string, unknown>;
type TelegramMethod = 'getMe' | 'getWebhookInfo' | 'getUpdates' | 'getChat' | 'getChatMember' | 'sendMessage' | 'answerCallbackQuery' | 'getFile';
const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
const APPROVAL_ACTION = /^rele:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(accept|decline)$/iu;
// The request ID only distinguishes this keyboard action, and remains valid after a restart.
const CHAT_PICKER_REQUEST_ID = 0x52454c45;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function numericId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? String(value) : undefined;
}
function routingThreadId(message: ObjectValue | undefined): string | undefined {
  // In groups, generic reply threads (including those in General) are not forum topics.
  if (message?.is_topic_message === true) return numericId(message.message_thread_id);
  return object(message?.chat)?.type === 'private' ? numericId(message?.message_thread_id) ?? '' : '';
}
function person(value: unknown): Person | undefined {
  const user = object(value);
  const id = numericId(user?.id);
  if (!user || !id || user.is_bot === true) return undefined;
  const name = [user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' ').trim();
  return { id, name: readableTitle(name || (typeof user.username === 'string' ? `@${user.username}` : ''), 'Участник Telegram') };
}
function membership(value: unknown, accountId: string): boolean | undefined {
  const member = object(value);
  const user = object(member?.user);
  if (!member || numericId(user?.id) !== accountId || user?.is_bot !== true) return undefined;
  if (['creator', 'administrator', 'member'].includes(member.status as string)) return true;
  if (member.status === 'restricted') return typeof member.is_member === 'boolean' ? member.is_member : undefined;
  if (member.status === 'left' || member.status === 'kicked') return false;
  return undefined;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export class TelegramChannel implements Channel {
  state: ConnectionState;
  private readonly fetcher: typeof fetch;
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly topics = new Map<string, string>();
  private accountId = '';
  private botUsername?: string;
  private controller?: AbortController;
  private starting?: Promise<void>;
  private polling?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private startupFailures = 0;
  private stopped = true;

  constructor(
    private readonly token: string,
    private readonly callbacks: ChannelCallbacks,
    private readonly checkpoint: { get(): number; set(offset: number): void },
    options: { fetch?: typeof fetch; knownEndpoints?: Endpoint[] } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.state = { configured: Boolean(token), connected: false };
    for (const endpoint of options.knownEndpoints ?? []) {
      if (endpoint.platform !== 'telegram') continue;
      this.endpoints.set(endpoint.id, endpoint);
      if (endpoint.threadId && endpoint.topicTitle) this.topics.set(endpoint.id, endpoint.topicTitle);
    }
  }

  discoveryInfo(): { botUrl?: string; command: string } {
    return { botUrl: this.botUsername ? `https://t.me/${this.botUsername}?start=rele_chats` : undefined,
      command: `/rele_register${this.botUsername ? `@${this.botUsername}` : ''}` };
  }

  async start(): Promise<void> {
    this.stopped = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    if (this.starting) return this.starting;
    if (this.polling && !this.controller?.signal.aborted) return;
    const controller = new AbortController();
    this.controller = controller;
    this.starting = this.connect(controller);
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async connect(controller: AbortController): Promise<void> {
    try {
      if (!/^\d+:[A-Za-z0-9_-]+$/u.test(this.token)) throw new ChannelError('Проверьте токен бота Telegram.');
      const me = object(await this.call('getMe', {}, false, controller.signal));
      const accountId = numericId(me?.id);
      if (!me || !accountId || me.is_bot !== true) throw new ChannelError('Telegram вернул некорректные сведения о боте.');
      if (accountId !== this.token.split(':', 1)[0]) throw new ChannelError('Telegram сообщил другую учётную запись бота. Проверьте токен.');
      const webhook = object(await this.call('getWebhookInfo', {}, false, controller.signal));
      if (!webhook || typeof webhook.url !== 'string') throw new ChannelError('Не удалось проверить webhook Telegram.');
      if (webhook.url) throw new ChannelError('У бота Telegram уже настроен webhook. Подключите отдельного бота или отключите webhook в прежнем приложении.');
      if (controller.signal.aborted) return;
      const offset = this.checkpoint.get();
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ChannelError('Не удалось прочитать сохранённую позицию Telegram.');
      this.accountId = accountId;
      this.botUsername = typeof me.username === 'string' && /^[A-Za-z0-9_]+$/u.test(me.username) ? me.username : undefined;
      this.startupFailures = 0;
      this.state.accountId = accountId;
      this.state.name = readableTitle(typeof me.username === 'string' ? `@${me.username}` : me.first_name, 'Бот Telegram');
      this.setStatus(true);
      this.polling = this.poll(controller.signal).finally(() => {
        if (this.controller === controller) { this.polling = undefined; this.setStatus(false, this.state.error); }
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const safe = error instanceof ChannelError ? error : new ChannelError('Не удалось подключить Telegram.');
      this.setStatus(false, safe.message);
      controller.abort();
      if (safe.retryable && !this.stopped) {
        const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.startupFailures++, 5));
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (!this.stopped) void this.start().catch(() => {});
        }, Math.max(backoff, safe.retryAfterMs));
        this.retry.unref();
      }
      throw safe;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.controller?.abort();
    await Promise.allSettled([this.starting, this.polling].filter((task): task is Promise<void> => Boolean(task)));
    this.setStatus(false, this.state.error);
  }

  private setStatus(connected: boolean, error?: string): void {
    const changed = this.state.connected !== connected || this.state.error !== error;
    this.state.connected = connected;
    this.state.error = error;
    if (changed) this.callbacks.status();
  }

  private async call(method: TelegramMethod, body: ObjectValue, sending = false, parentSignal = this.controller?.signal): Promise<unknown> {
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 20_000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    let response: Response;
    let data: ObjectValue | undefined;
    try {
      response = await abortable(this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      }), signal);
    } catch {
      throw new ChannelError(sending ? 'Не получено подтверждение отправки Telegram. Проверьте чат перед повтором.' : 'Telegram временно недоступен.', !sending, sending, sending ? 30_000 : 1_000);
    }
    try { data = object(await abortable(response.json(), signal)); } catch { data = undefined; }
    if (data?.ok === true && response.ok && 'result' in data) return data.result;
    const code = typeof data?.error_code === 'number' ? data.error_code : response.status;
    if (code === 429) {
      const retryAfter = object(data?.parameters)?.retry_after;
      const wait = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(2_147_000_000, Math.max(1_000, retryAfter * 1_000)) : 30_000;
      throw new ChannelError('Telegram ограничил частоту запросов. Отправка будет повторена позже.', true, false, wait);
    }
    if (code >= 400 && code < 500) {
      const message = code === 401 ? 'Telegram отклонил токен бота.' : code === 403 ? 'У бота Telegram нет доступа к этому чату.' :
        code === 409 ? 'Этот бот Telegram уже используется другим получателем обновлений.' : 'Telegram отклонил запрос. Проверьте чат, тему и права бота.';
      throw new ChannelError(message);
    }
    throw new ChannelError(sending ? 'Не получено подтверждение отправки Telegram. Проверьте чат перед повтором.' : 'Telegram вернул некорректный ответ.', !sending, sending, sending ? 30_000 : 1_000);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call('getUpdates', { offset: this.checkpoint.get(), timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, false, signal);
        if (!Array.isArray(updates)) throw new ChannelError('Telegram вернул некорректный список сообщений.', true);
        this.setStatus(true);
        const ordered = updates.map((value) => {
          const update = object(value);
          if (!update || !Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0 || update.update_id === Number.MAX_SAFE_INTEGER) throw new ChannelError('Telegram вернул сообщение без корректного номера события.', true);
          return update;
        }).sort((a, b) => (a.update_id as number) - (b.update_id as number));
        for (const update of ordered) {
          const id = update.update_id as number;
          if (id < this.checkpoint.get()) continue;
          await this.handleUpdate(update, signal);
          if (signal.aborted) return;
          this.checkpoint.set(id + 1);
        }
        failures = 0;
        if (!updates.length) await delay(100, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        const safe = error instanceof ChannelError ? error : new ChannelError('Не удалось сохранить сообщение Telegram. Получение будет повторено.', true, false, 1_000);
        this.setStatus(false, safe.message);
        if (!safe.retryable && !safe.uncertain) return;
        const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
        try { await delay(Math.max(backoff, safe.retryAfterMs), undefined, { signal }); } catch { return; }
      }
    }
  }

  private async handleUpdate(update: ObjectValue, signal: AbortSignal): Promise<void> {
    const changedMembership = object(update.my_chat_member);
    if (changedMembership) {
      const chat = object(changedMembership.chat);
      const chatId = numericId(chat?.id);
      const available = membership(changedMembership.new_chat_member, this.accountId);
      if (chat && chatId && ['private', 'group', 'supergroup'].includes(chat.type as string) && available !== undefined) {
        this.discover(chat, chatId, '', person(changedMembership.from), available);
      }
      return;
    }
    const callback = object(update.callback_query);
    if (callback) { await this.handleAction(callback, signal); return; }
    const message = object(update.message);
    const chat = object(message?.chat);
    const chatId = numericId(chat?.id);
    const messageId = numericId(message?.message_id);
    if (!message || !chat || !chatId || !messageId || !['private', 'group', 'supergroup'].includes(chat.type as string)) return;
    const sender = person(message.from);
    const threadId = routingThreadId(message);
    if (threadId === undefined) return;
    const topicKey = endpointId('telegram', this.accountId, chatId, threadId);
    const topic = object(message.forum_topic_created) ?? object(message.forum_topic_edited);
    const previousTopic = object(object(message.reply_to_message)?.forum_topic_created);
    if (typeof topic?.name === 'string' && topic.name.trim()) this.topics.set(topicKey, readableTitle(topic.name, 'Тема Telegram', 128));
    else if (!this.topics.has(topicKey) && !this.endpoints.get(topicKey)?.topicTitle && typeof previousTopic?.name === 'string' && previousTopic.name.trim()) {
      this.topics.set(topicKey, readableTitle(previousTopic.name, 'Тема Telegram', 128));
    }
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    const command = /^\/(rele_register|rele_chats|start)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/iu.exec(typeof message.text === 'string' ? message.text.trimEnd() : '');
    const register = command?.[1].toLowerCase() === 'rele_register';
    const picker = command?.[1].toLowerCase() === 'rele_chats' || (command?.[1].toLowerCase() === 'start' && command[3]?.trim() === 'rele_chats');
    if ((register || picker) && command?.[2] && command[2].toLowerCase() !== this.botUsername?.toLowerCase()) return;
    const ownDeparture = numericId(object(message.left_chat_member)?.id) === this.accountId;
    const hasContent = Boolean(text.trim()) || ['photo', 'voice', 'audio', 'video', 'video_note', 'document', 'sticker', 'animation', 'contact', 'location', 'venue', 'poll', 'dice', 'paid_media', 'story', 'checklist'].some(key => message[key] !== undefined);
    const generalTopic = !threadId && this.isForum(chat, chatId, threadId) && Boolean(sender) && !message.sender_chat && hasContent &&
      !ownDeparture && !message.chat_shared && !message.forum_topic_created && !message.forum_topic_edited;
    if (register && sender && !message.sender_chat && (threadId || generalTopic) && command?.[3]?.trim()) this.topics.set(topicKey, readableTitle(command[3], 'Тема Telegram', 128));
    const endpoint = this.discover(chat, chatId, threadId, sender, !ownDeparture, generalTopic);
    if (ownDeparture) return;
    if (message.chat_shared) {
      if (chat.type === 'private' && sender?.id === chatId && !message.sender_chat) await this.handleSharedChat(message.chat_shared, sender, signal);
      return;
    }
    if (!sender || sender.id === this.accountId || message.sender_chat) return;
    if (picker || register) {
      if (picker && (chat.type !== 'private' || sender.id !== chatId)) return;
      const reply: ObjectValue = { chat_id: chatId,
        text: picker ? 'Выберите группу, в которой уже есть этот бот. Для отдельной темы отправьте команду регистрации внутри неё.' :
          `Добавлено в каталог Rele: ${endpoint.title}. ${endpoint.isForum && !threadId && !endpoint.generalTopic ? `Чтобы связать тему с Codex, отправьте ${this.discoveryInfo().command} внутри нужной темы.` : 'Теперь выберите этот чат или тему в панели Rele.'}`,
        reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true }, link_preview_options: { is_disabled: true } };
      if (threadId) reply.message_thread_id = Number(threadId);
      if (picker) reply.reply_markup = { keyboard: [[{ text: 'Выбрать группу', request_chat: {
        request_id: CHAT_PICKER_REQUEST_ID, chat_is_channel: false, bot_is_member: true, request_title: true,
      } }]], resize_keyboard: true, one_time_keyboard: true, selective: true };
      await this.replyToCommand(reply, chatId, threadId, signal);
      return;
    }
    if (message.forum_topic_created || message.forum_topic_edited) return;
    const audioSource = object(message.voice) ?? object(message.audio) ??
      (typeof object(message.document)?.mime_type === 'string' && (object(message.document)!.mime_type as string).startsWith('audio/') ? object(message.document) : undefined);
    let audio: AudioAttachment | undefined;
    if (audioSource && typeof audioSource.file_id === 'string' && audioSource.file_id) {
      audio = { platform: 'telegram', fileId: audioSource.file_id,
        name: readableTitle(audioSource.file_name, message.voice ? 'voice.ogg' : 'audio.mp3', 120).replace(/[\\/]/gu, '_'),
        mimeType: typeof audioSource.mime_type === 'string' ? audioSource.mime_type : message.voice ? 'audio/ogg' : undefined,
        size: typeof audioSource.file_size === 'number' && Number.isSafeInteger(audioSource.file_size) && audioSource.file_size >= 0 ? audioSource.file_size : undefined };
    }
    if (!text.trim() && !audio) return;
    const inbound: InboundMessage = { eventId: String(update.update_id), endpoint, sender, messageId, text, audio,
      replyToMessageId: numericId(object(message.reply_to_message)?.message_id) };
    await abortable(this.callbacks.message(inbound), signal);
  }

  private remember(endpoint: Endpoint): Endpoint {
    this.callbacks.endpoint(endpoint);
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  private isForum(chat: ObjectValue, chatId: string, threadId: string): boolean {
    const knownParent = this.endpoints.get(endpointId('telegram', this.accountId, chatId, ''));
    const hasKnownTopic = [...this.endpoints.values()].some((endpoint) => endpoint.accountId === this.accountId && endpoint.chatId === chatId && Boolean(endpoint.threadId));
    return chat.type !== 'private' && (chat.is_forum === true || Boolean(threadId) || knownParent?.isForum === true || hasKnownTopic);
  }

  private discover(chat: ObjectValue, chatId: string, threadId: string, sender?: Person, available = true, generalTopic = false): Endpoint {
    const isForum = this.isForum(chat, chatId, threadId);
    const parent = this.remember(this.describe(chat, chatId, '', sender, available, isForum, generalTopic));
    for (const existing of this.endpoints.values()) {
      if (existing.accountId !== this.accountId || existing.chatId !== chatId || !existing.threadId || existing.threadId === threadId) continue;
      if (existing.available !== available || existing.chatTitle !== parent.chatTitle || existing.isForum !== isForum) {
        this.remember(this.describe(chat, chatId, existing.threadId, undefined, available, isForum));
      }
    }
    return threadId ? this.remember(this.describe(chat, chatId, threadId, sender, available, isForum)) : parent;
  }

  private describe(chat: ObjectValue, chatId: string, threadId: string, sender: Person | undefined, available: boolean, isForum: boolean, observedGeneral = false): Endpoint {
    const id = endpointId('telegram', this.accountId, chatId, threadId);
    const existing = this.endpoints.get(id);
    const parent = this.endpoints.get(endpointId('telegram', this.accountId, chatId, ''));
    const name = chat.type === 'private' ? [chat.first_name, chat.last_name].filter((part) => typeof part === 'string').join(' ').trim() || sender?.name : chat.title;
    const chatTitle = readableTitle(name, existing?.chatTitle ?? parent?.chatTitle ?? parent?.title ?? (chat.type === 'private' ? 'Личный чат Telegram' : 'Группа Telegram'));
    const oldPrefix = `${existing?.chatTitle ?? chatTitle} / `;
    const generalTopic = !threadId && isForum && (observedGeneral || existing?.generalTopic === true);
    const topicTitle = threadId || isForum ? this.topics.get(id) ?? existing?.topicTitle ?? (existing?.title.startsWith(oldPrefix) ? existing.title.slice(oldPrefix.length) : undefined) ?? (generalTopic ? 'Общая тема' : undefined) : undefined;
    const title = threadId || generalTopic ? topicTitle ? `${chatTitle} / ${topicTitle}` : existing?.title ?? `${chatTitle} / Тема без названия` : chatTitle;
    const username = typeof chat.username === 'string' && /^[A-Za-z0-9_]+$/u.test(chat.username) ? chat.username : undefined;
    const url = chat.type === 'private' && this.botUsername ? `https://t.me/${this.botUsername}` : username ? `https://t.me/${username}${threadId ? `/${threadId}` : ''}` : existing?.url;
    const people = new Map((existing?.people ?? []).map((entry) => [entry.id, entry]));
    if (sender) people.set(sender.id, sender);
    return { id, platform: 'telegram', accountId: this.accountId, chatId, threadId, title, chatTitle, topicTitle, isForum, generalTopic: generalTopic || undefined, available,
      subtitle: generalTopic ? 'Общая тема · Telegram' : threadId ? 'Тема · Telegram' : chat.type === 'private' ? 'Личный чат · Telegram' : 'Группа · Telegram',
      url, people: [...people.values()], updatedAt: new Date().toISOString() };
  }

  private async handleSharedChat(value: unknown, sender: Person, signal: AbortSignal): Promise<void> {
    const shared = object(value);
    const chatId = numericId(shared?.chat_id);
    if (!shared || shared.request_id !== CHAT_PICKER_REQUEST_ID || !chatId) return;
    let chat: ObjectValue | undefined;
    let available: boolean | undefined;
    try {
      chat = object(await this.call('getChat', { chat_id: chatId }, false, signal));
      if (!chat || numericId(chat.id) !== chatId || !['group', 'supergroup'].includes(chat.type as string)) throw new ChannelError('Telegram не подтвердил выбранную группу.');
      available = membership(await this.call('getChatMember', { chat_id: chatId, user_id: Number(this.accountId) }, false, signal), this.accountId);
      if (available === undefined) throw new ChannelError('Telegram не подтвердил участие бота в выбранной группе.');
    } catch (error) {
      if (signal.aborted || (error instanceof ChannelError && error.retryable)) throw error;
      this.setStatus(true, error instanceof ChannelError ? error.message : 'Не удалось проверить выбранную группу Telegram.');
      return;
    }
    this.discover(chat, chatId, '', sender, available);
  }

  private async replyToCommand(payload: ObjectValue, chatId: string, threadId: string, signal: AbortSignal): Promise<void> {
    try {
      const result = object(await this.call('sendMessage', payload, true, signal));
      if (!numericId(result?.message_id) || numericId(object(result?.chat)?.id) !== chatId || routingThreadId(result) !== threadId) {
        throw new ChannelError('Telegram не подтвердил служебный ответ. Повторите команду в чате при необходимости.', false, true);
      }
    } catch (error) {
      if (signal.aborted || (error instanceof ChannelError && error.retryable)) throw error;
      // An unknown send outcome must not replay a command automatically.
      this.setStatus(true, error instanceof ChannelError ? error.message : 'Не удалось ответить на команду Telegram.');
    }
  }

  private async handleAction(query: ObjectValue, signal: AbortSignal): Promise<void> {
    if (typeof query.id !== 'string') return;
    const match = typeof query.data === 'string' ? APPROVAL_ACTION.exec(query.data) : null;
    const sender = person(query.from);
    const message = object(query.message);
    const chatId = numericId(object(message?.chat)?.id);
    const threadId = routingThreadId(message);
    let accepted = false;
    try {
      if (match && sender && chatId && threadId !== undefined) {
        await abortable(this.callbacks.action({ approvalId: match[1], decision: match[2].toLowerCase() as 'accept' | 'decline', platform: 'telegram',
          accountId: this.accountId, chatId, threadId, senderId: sender.id }), signal);
        accepted = true;
      }
    } catch (error) {
      if (signal.aborted || (error instanceof ChannelError && error.retryable)) throw error;
    } finally {
      if (!signal.aborted) {
        try { await this.call('answerCallbackQuery', { callback_query_id: query.id, text: accepted ? 'Ответ принят.' : 'Действие недоступно.', show_alert: !accepted }, false, signal); }
        catch { /* The approval result remains authoritative if the acknowledgement expires. */ }
      }
    }
  }

  async deliver(delivery: Delivery, approval?: Approval): Promise<string> {
    if (!this.accountId || this.controller?.signal.aborted) throw new ChannelError('Telegram ещё не подключён.', true);
    const origin = delivery.origin;
    if (origin.platform !== 'telegram' || origin.accountId !== this.accountId) throw new ChannelError('Получатель относится к другому боту Telegram. Проверьте настройки связки.');
    if (numericId(Number(origin.chatId)) !== origin.chatId || numericId(Number(origin.messageId)) !== origin.messageId || Number(origin.messageId) < 0 ||
      (origin.threadId && (numericId(Number(origin.threadId)) !== origin.threadId || Number(origin.threadId) < 0))) throw new ChannelError('Некорректный адрес ответа Telegram.');
    if (!delivery.body || [...delivery.body].length > 4096) throw new ChannelError('Текст Telegram должен содержать от 1 до 4096 символов.');
    const payload: ObjectValue = { chat_id: origin.chatId, text: delivery.body,
      reply_parameters: { message_id: Number(origin.messageId), allow_sending_without_reply: true }, link_preview_options: { is_disabled: true } };
    if (origin.threadId) payload.message_thread_id = Number(origin.threadId);
    if (approval) {
      if (approval.requestId !== delivery.requestId || approval.id !== delivery.approvalId) throw new ChannelError('Подтверждение не относится к этому сообщению.');
      if (approval.questions?.length) payload.reply_markup = { force_reply: true, selective: true, input_field_placeholder: 'Ответьте на вопрос Codex' };
      else {
        const accept = `rele:${approval.id}:accept`;
        const decline = `rele:${approval.id}:decline`;
        if (!APPROVAL_ACTION.test(accept) || Buffer.byteLength(decline) > 64) throw new ChannelError('Некорректное подтверждение Telegram.');
        payload.reply_markup = { inline_keyboard: [[{ text: 'Разрешить', callback_data: accept }, { text: 'Отклонить', callback_data: decline }]] };
      }
    }
    const result = object(await this.call('sendMessage', payload, true));
    const sentId = numericId(result?.message_id);
    if (!sentId || numericId(object(result?.chat)?.id) !== origin.chatId || routingThreadId(result) !== origin.threadId) {
      throw new ChannelError('Telegram не подтвердил адрес и номер отправленного сообщения. Проверьте чат перед повтором.', false, true);
    }
    return sentId;
  }

  async download(audio: AudioAttachment, file: string): Promise<void> {
    if (!this.accountId || this.controller?.signal.aborted) throw new ChannelError('Telegram ещё не подключён.', true);
    if (audio.platform !== 'telegram' || !audio.fileId) throw new ChannelError('Не найден аудиофайл Telegram.');
    if (audio.size !== undefined && audio.size > MAX_AUDIO_SIZE) throw new ChannelError('Аудиофайл превышает 20 МБ.');
    const info = object(await this.call('getFile', { file_id: audio.fileId }));
    if (typeof info?.file_size === 'number' && info.file_size > MAX_AUDIO_SIZE) throw new ChannelError('Аудиофайл превышает 20 МБ.');
    const path = info?.file_path;
    if (typeof path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
      throw new ChannelError('Telegram вернул некорректный путь аудиофайла.');
    }
    const timeout = AbortSignal.timeout(60_000);
    const signal = this.controller ? AbortSignal.any([this.controller.signal, timeout]) : timeout;
    try {
      const response = await abortable(this.fetcher(`https://api.telegram.org/file/bot${this.token}/${path}`, { redirect: 'error', signal }), signal);
      await abortable(downloadBounded(response, file, MAX_AUDIO_SIZE), signal);
    } catch (error) {
      throw error instanceof ChannelError ? error : new ChannelError('Не удалось скачать аудиофайл Telegram.', true);
    }
  }
}

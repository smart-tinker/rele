import { setTimeout as delay } from 'node:timers/promises';
import type { Approval, AudioAttachment, ConnectionState, Delivery, Endpoint, InboundMessage, Person } from '../../shared/types.js';
import { ChannelError, downloadBounded, endpointId, readableTitle, type Channel, type ChannelCallbacks } from './common.js';

type ObjectValue = Record<string, unknown>;
type TelegramMethod = 'getMe' | 'getWebhookInfo' | 'getUpdates' | 'sendMessage' | 'answerCallbackQuery' | 'getFile';
const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
const APPROVAL_ACTION = /^rele:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(accept|decline)$/iu;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function numericId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? String(value) : undefined;
}
function person(value: unknown): Person | undefined {
  const user = object(value);
  const id = numericId(user?.id);
  if (!user || !id || user.is_bot === true) return undefined;
  const name = [user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' ').trim();
  return { id, name: readableTitle(name || (typeof user.username === 'string' ? `@${user.username}` : ''), 'Участник Telegram') };
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
  private controller?: AbortController;
  private starting?: Promise<void>;
  private polling?: Promise<void>;

  constructor(
    private readonly token: string,
    private readonly callbacks: ChannelCallbacks,
    private readonly checkpoint: { get(): number; set(offset: number): void },
    options: { fetch?: typeof fetch; knownEndpoints?: Endpoint[] } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.state = { configured: Boolean(token), connected: false };
    for (const endpoint of options.knownEndpoints ?? []) if (endpoint.platform === 'telegram') this.endpoints.set(endpoint.id, endpoint);
  }

  async start(): Promise<void> {
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
      const webhook = object(await this.call('getWebhookInfo', {}, false, controller.signal));
      if (!webhook || typeof webhook.url !== 'string') throw new ChannelError('Не удалось проверить webhook Telegram.');
      if (webhook.url) throw new ChannelError('У бота Telegram уже настроен webhook. Подключите отдельного бота или отключите webhook в прежнем приложении.');
      if (controller.signal.aborted) return;
      const offset = this.checkpoint.get();
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ChannelError('Не удалось прочитать сохранённую позицию Telegram.');
      this.accountId = accountId;
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
      throw safe;
    }
  }

  async stop(): Promise<void> {
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
      throw new ChannelError(sending ? 'Не получено подтверждение отправки Telegram. Проверьте чат перед повтором.' : 'Telegram временно недоступен.', !sending, sending);
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
    throw new ChannelError(sending ? 'Не получено подтверждение отправки Telegram. Проверьте чат перед повтором.' : 'Telegram вернул некорректный ответ.', !sending, sending);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call('getUpdates', { offset: this.checkpoint.get(), timeout: 25, allowed_updates: ['message', 'callback_query'] }, false, signal);
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
    const callback = object(update.callback_query);
    if (callback) { await this.handleAction(callback, signal); return; }
    const message = object(update.message);
    const chat = object(message?.chat);
    const chatId = numericId(chat?.id);
    const messageId = numericId(message?.message_id);
    if (!message || !chat || !chatId || !messageId || !['private', 'group', 'supergroup'].includes(chat.type as string)) return;
    const sender = person(message.from);
    const threadId = numericId(message.message_thread_id) ?? '';
    const topicKey = `${chatId}:${threadId}`;
    const topic = object(message.forum_topic_created) ?? object(message.forum_topic_edited) ?? object(object(message.reply_to_message)?.forum_topic_created);
    if (topic && typeof topic.name === 'string' && topic.name.trim()) this.topics.set(topicKey, readableTitle(topic.name, 'Тема Telegram', 128));
    const endpoint = this.discover(chat, chatId, threadId, sender);
    this.callbacks.endpoint(endpoint);
    if (!sender || sender.id === this.accountId || message.sender_chat) return;
    const audioSource = object(message.voice) ?? object(message.audio) ??
      (typeof object(message.document)?.mime_type === 'string' && (object(message.document)!.mime_type as string).startsWith('audio/') ? object(message.document) : undefined);
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
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

  private discover(chat: ObjectValue, chatId: string, threadId: string, sender?: Person): Endpoint {
    const id = endpointId('telegram', this.accountId, chatId, threadId);
    const existing = this.endpoints.get(id);
    const name = chat.type === 'private' ? [chat.first_name, chat.last_name].filter((part) => typeof part === 'string').join(' ').trim() || sender?.name : chat.title;
    const chatTitle = readableTitle(name, chat.type === 'private' ? 'Личный чат Telegram' : 'Группа Telegram');
    const topicName = this.topics.get(`${chatId}:${threadId}`);
    const title = threadId ? topicName ? `${chatTitle} / ${topicName}` : existing?.title ?? `${chatTitle} / Тема без названия` : chatTitle;
    const username = typeof chat.username === 'string' && /^[A-Za-z0-9_]+$/u.test(chat.username) ? chat.username : undefined;
    const url = username ? `https://t.me/${username}${threadId ? `/${threadId}` : ''}` : existing?.url;
    const people = new Map((existing?.people ?? []).map((entry) => [entry.id, entry]));
    if (sender) people.set(sender.id, sender);
    const endpoint: Endpoint = { id, platform: 'telegram', accountId: this.accountId, chatId, threadId, title,
      subtitle: threadId ? 'Тема · Telegram' : chat.type === 'private' ? 'Личный чат · Telegram' : 'Группа · Telegram',
      url, people: [...people.values()], updatedAt: new Date().toISOString() };
    this.endpoints.set(id, endpoint);
    return endpoint;
  }

  private async handleAction(query: ObjectValue, signal: AbortSignal): Promise<void> {
    if (typeof query.id !== 'string') return;
    const match = typeof query.data === 'string' ? APPROVAL_ACTION.exec(query.data) : null;
    const sender = person(query.from);
    const message = object(query.message);
    const chatId = numericId(object(message?.chat)?.id);
    let accepted = false;
    try {
      if (match && sender && chatId) {
        await abortable(this.callbacks.action({ approvalId: match[1], decision: match[2].toLowerCase() as 'accept' | 'decline', platform: 'telegram',
          accountId: this.accountId, chatId, threadId: numericId(message?.message_thread_id) ?? '', senderId: sender.id }), signal);
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
    if (!sentId || numericId(object(result?.chat)?.id) !== origin.chatId || (origin.threadId && numericId(result?.message_thread_id) !== origin.threadId)) {
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

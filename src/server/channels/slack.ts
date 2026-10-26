import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { Approval, AudioAttachment, CatalogChat, CatalogPage, ConnectionState, Delivery, Endpoint, InboundMessage, Origin, Person, SlackTranscriptMessage } from '../../shared/types.js';
import { ChannelError, downloadBounded, endpointId, readableTitle, splitReply, type Channel, type ChannelCallbacks, type SlackSessionStatus } from './common.js';
import { escapeSlackText, formatSlackReply } from './slack-format.js';

type Json = Record<string, any>;
const SLACK_TS = /^\d+\.\d+$/u;
const SLACK_USER = /^[UW][A-Z0-9]+$/u;
const SLACK_BOT = /^B[A-Z0-9]+$/u;
const CONVERSATION_TYPES = [
  ['public_channel', 'channels:read'], ['private_channel', 'groups:read'], ['im', 'im:read'], ['mpim', 'mpim:read'],
] as const;
const PAYLOAD_NOISE = new Set(['token', 'access_token', 'refresh_token', 'authorization', 'response_url', 'bot_profile', 'user_profile', 'event_ts', 'client_msg_id', 'team', 'channel', 'reply_count', 'reply_users', 'reply_users_count', 'latest_reply', 'last_read', 'subscribed', 'reactions']);

function visiblePayload(value: unknown): any {
  if (Array.isArray(value)) return value.map(visiblePayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PAYLOAD_NOISE.has(key.toLowerCase())).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, visiblePayload(item)]));
}

function transcriptPayload(message: Json): Json {
  return visiblePayload(Object.fromEntries(['type', 'subtype', 'ts', 'thread_ts', 'user', 'bot_id', 'app_id', 'username', 'text', 'blocks', 'attachments', 'files', 'edited'].filter(key => message[key] !== undefined).map(key => [key, key === 'type' ? 'message' : key === 'edited' ? { ts: message.edited?.ts } : message[key]])));
}

function messageText(message: Json): string {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  const pieces: string[] = [];
  const visit = (value: any) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string') pieces.push(value.text);
    if (typeof value.title === 'string') pieces.push(value.title);
    if (typeof value.value === 'string' && typeof value.title === 'string') pieces.push(value.value);
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  };
  visit(message.blocks);
  visit(message.attachments);
  return pieces.join('\n');
}

function hasDirectMention(text: string, botUserId: string): boolean {
  return text.split(/(`{3,}[\s\S]*?(?:`{3,}|$)|~{3,}[\s\S]*?(?:~{3,}|$)|``[^\n]*?``|`[^`\n]*`)/gu).some((part, index) => index % 2 === 0 && part.split('\n').some(line => !/^\s*>/u.test(line) && line.includes(`<@${botUserId}>`)));
}

function hasBlockMention(value: unknown, botUserId: string): boolean {
  if (Array.isArray(value)) return value.some(item => hasBlockMention(item, botUserId));
  if (!value || typeof value !== 'object') return false;
  const node = value as Json;
  if (node.style?.code || ['rich_text_quote', 'rich_text_preformatted'].includes(node.type)) return false;
  if (node.type === 'user' && node.user_id === botUserId) return true;
  if (['markdown', 'mrkdwn'].includes(node.type) && typeof node.text === 'string' && hasDirectMention(node.text, botUserId)) return true;
  return ['elements', 'element', 'text', 'fields'].some(key => hasBlockMention(node[key], botUserId));
}
export interface SlackOptions {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  knownEndpoints?: Endpoint[];
}

/** Socket Mode needs outbound connections only. ACK follows the durable inbox write. */
export class SlackChannel implements Channel {
  identity?: Person;
  state: ConnectionState = { configured: true, connected: false };
  private readonly fetcher: typeof fetch;
  private socket?: WebSocket;
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private retries = 0;
  private alive = true;
  private teamId = '';
  private botUserId = '';
  private botId = '';
  private accountId = '';
  private teamName = 'Slack';
  private processing: Promise<void> = Promise.resolve();
  private endpoints = new Map<string, Endpoint>();
  private people = new Map<string, Person>();
  private profiles = new Map<string, Json>();
  private channelNames = new Map<string, string>();
  private conversations = new Map<string, Json>();
  private catalogScopes?: Set<string>;
  private refreshing = new Set<string>();
  private abort = new AbortController();

  constructor(private readonly botToken: string, private readonly appToken: string, private readonly callbacks: ChannelCallbacks, private readonly options: SlackOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    for (const endpoint of options.knownEndpoints ?? []) if (endpoint.platform === 'slack') {
      this.endpoints.set(endpoint.id, endpoint);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.abort = new AbortController();
    clearTimeout(this.retry);
    try {
      const identity = await this.api('auth.test', {});
      if (!identity.team_id || !identity.user_id) throw new ChannelError('Slack не сообщил учётную запись бота.');
      if (this.stopped) return;
      this.teamId = identity.team_id;
      this.botUserId = identity.user_id;
      this.botId = typeof identity.bot_id === 'string' && SLACK_BOT.test(identity.bot_id) ? identity.bot_id : '';
      this.identity = { id: this.botUserId, name: readableTitle(identity.user, 'Подключённый агент Slack'), isBot: true };
      const accountId = `${this.teamId}:${this.botUserId}`;
      if (this.accountId !== accountId) {
        this.endpoints = new Map([...this.endpoints].filter(([, endpoint]) => endpoint.accountId === accountId));
        this.people.clear();
        this.profiles.clear();
        this.channelNames.clear();
        for (const endpoint of this.endpoints.values()) for (const person of endpoint.people) this.people.set(person.id, person);
      }
      this.accountId = accountId;
      this.conversations.clear();
      this.teamName = readableTitle(identity.team, 'Slack');
      this.setState({ accountId, name: this.teamName });
      const connection = await this.api('apps.connections.open', {}, this.appToken);
      const url = new URL(connection.url);
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com') || url.username || url.password) throw new ChannelError('Slack вернул неподдерживаемый адрес Socket Mode.');
      if (this.stopped) return;
      const socket = this.options.socket?.(url.href) ?? new WebSocket(url.href, { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024, followRedirects: false });
      this.socket = socket;
      socket.on('error', () => {});
      socket.on('message', raw => {
        this.processing = this.processing.then(() => this.receive(raw.toString(), socket)).catch(() => {
          this.setState({ error: 'Не удалось сохранить событие Slack. Slack сможет повторить его доставку.' });
        });
      });
      socket.on('pong', () => { this.alive = true; });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        clearInterval(this.heartbeat);
        this.socket = undefined;
        this.setState({ connected: false });
        this.schedule();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new ChannelError('Не удалось открыть Slack Socket Mode.')));
        socket.once('close', () => reject(new ChannelError('Slack закрыл соединение.')));
      });
      this.retries = 0;
      this.alive = true;
      this.setState({ connected: true, name: this.teamName, error: undefined });
      this.heartbeat = setInterval(() => {
        if (!this.alive) { socket.terminate(); return; }
        this.alive = false;
        socket.ping();
      }, 30_000);
      this.heartbeat.unref();
    } catch (error) {
      if (!this.stopped) {
        this.setState({ connected: false, error: error instanceof ChannelError ? error.message : 'Не удалось подключить Slack.' });
        this.schedule();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.abort.abort();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    await this.processing;
    this.setState({ connected: false });
  }

  async listChats(cursor?: string): Promise<CatalogPage<CatalogChat>> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    if (!cursor) this.conversations.clear();
    const page = await this.conversationPage(cursor);
    const items: CatalogChat[] = [];
    for (const conversation of page.items) {
      this.requireAccount(accountId, signal);
      const name = await this.conversationName(conversation);
      items.push({
        id: conversation.id, name,
        kind: conversation.is_im ? 'direct' : conversation.is_mpim ? 'group' : 'channel',
        subtitle: `${this.teamName} · ${conversation.is_im ? 'Личные сообщения' : conversation.is_mpim ? 'Групповой чат' : conversation.is_private ? 'Закрытый канал' : 'Канал'}`,
      });
    }
    this.requireAccount(accountId, signal);
    return { items, nextCursor: page.nextCursor, ...(page.warning ? { warning: page.warning } : {}) };
  }

  async listThreads(chatId: string, cursor?: string): Promise<CatalogPage<Endpoint>> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    const conversation = await this.requireConversation(chatId);
    this.requireAccount(accountId, signal);
    const chatTitle = await this.conversationName(conversation);
    this.requireAccount(accountId, signal);
    const data = await this.api('conversations.history', { channel: chatId, limit: 100, ...(cursor ? { cursor } : {}) });
    this.requireAccount(accountId, signal);
    if (!Array.isArray(data.messages)) throw new ChannelError('Slack вернул неразборчивую историю разговора.');
    this.setAvailability(chatId, true, accountId, signal);
    const items: Endpoint[] = [];
    for (const message of data.messages) {
      if (!message || message.type !== 'message' || typeof message.ts !== 'string' || !/^\d+\.\d+$/u.test(message.ts)) continue;
      if (message.thread_ts && message.thread_ts !== message.ts) continue;
      if (message.subtype && !['file_share', 'bot_message', 'me_message'].includes(message.subtype)) continue;
      const date = new Date(Number(message.ts) * 1000);
      if (!Number.isFinite(date.getTime())) continue;
      const text = readableTitle(message.text, readableTitle(message.files?.[0]?.title || message.files?.[0]?.name, 'Сообщение без текста'), 160);
      const id = endpointId('slack', accountId, chatId, message.ts);
      const previous = this.endpoints.get(id);
      const replies = Number.isSafeInteger(message.reply_count) && message.reply_count > 0 ? message.reply_count : 0;
      const endpoint: Endpoint = {
        id, platform: 'slack', accountId, chatId, threadId: message.ts,
        title: readableTitle(text, 'Обсуждение Slack'), chatTitle, available: true,
        subtitle: `${this.teamName} · ${chatTitle} · ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC · Ответов: ${replies} · ${text}`,
        url: `slack://channel?team=${encodeURIComponent(this.teamId)}&id=${encodeURIComponent(chatId)}&message=${encodeURIComponent(message.ts)}`,
        people: previous?.people ?? [], updatedAt: new Date().toISOString(),
      };
      this.requireAccount(accountId, signal);
      this.endpoints.set(id, endpoint);
      this.callbacks.endpoint(endpoint);
      items.push(endpoint);
    }
    return { items, nextCursor: this.nextCursor(data) };
  }

  async listPeople(chatId: string, cursor?: string): Promise<CatalogPage<Person>> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    const conversation = await this.requireConversation(chatId);
    this.requireAccount(accountId, signal);
    const page = await this.peoplePage(conversation, cursor);
    this.requireAccount(accountId, signal);
    return page;
  }

  async setThreadStatus(origin: Origin, status: SlackSessionStatus): Promise<void> {
    const accountId = this.requireAccount(origin.accountId);
    const signal = this.abort.signal;
    if (origin.platform !== 'slack' || !/^[CDG][A-Z0-9]+$/u.test(origin.chatId) || !SLACK_TS.test(origin.threadId)) throw new ChannelError('Некорректное обсуждение Slack.');
    const result = await this.api('agents.sessions.setStatus', { channel_id: origin.chatId, thread_ts: origin.threadId, status });
    this.requireAccount(accountId, signal);
    const warning = 'Для штатной кнопки Stop добавьте agent_session_stopped в Event Subscriptions приложения Slack.';
    const missingStop = result.response_metadata?.warnings?.includes('missing_agent_session_stopped_event_subscription') || result.warning === 'missing_agent_session_stopped_event_subscription';
    if (missingStop && this.state.error !== warning) this.setState({ error: warning });
    else if (!missingStop && this.state.error === warning) this.setState({ error: undefined });
  }

  async readThreadPage(target: Pick<Origin, 'endpointId' | 'accountId' | 'chatId' | 'threadId'>, options: { cursor?: string; oldest?: string; latest?: string } = {}): Promise<{ messages: SlackTranscriptMessage[]; nextCursor?: string }> {
    const accountId = this.requireAccount(target.accountId);
    const signal = this.abort.signal;
    if (!/^[CDG][A-Z0-9]+$/u.test(target.chatId) || !SLACK_TS.test(target.threadId) || target.endpointId !== endpointId('slack', accountId, target.chatId, target.threadId)) throw new ChannelError('Некорректный источник истории Slack.');
    for (const bound of [options.oldest, options.latest]) if (bound !== undefined && !SLACK_TS.test(bound)) throw new ChannelError('Некорректная граница истории Slack.');
    if (options.cursor !== undefined && (!options.cursor.trim() || options.cursor.length > 2000 || /[\x00-\x1f]/u.test(options.cursor))) throw new ChannelError('Некорректная страница истории Slack.');
    const data = await this.api('conversations.replies', { channel: target.chatId, ts: target.threadId, limit: 100, inclusive: true, ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.oldest !== undefined ? { oldest: options.oldest } : {}), ...(options.latest !== undefined ? { latest: options.latest } : {}) });
    this.requireAccount(accountId, signal);
    if (!Array.isArray(data.messages)) throw new ChannelError('Slack вернул неразборчивую историю обсуждения.');
    const messages = data.messages.map((raw: Json) => {
      const source = this.messageSource(raw, target.chatId);
      if (!source || (source.message.thread_ts || source.message.ts) !== target.threadId) throw new ChannelError('Slack вернул сообщение из другого обсуждения.');
      return this.transcript(source.message, source.kind, target.endpointId);
    });
    this.requireAccount(accountId, signal);
    return { messages, nextCursor: this.nextCursor(data) };
  }

  private requireAccount(expected = this.accountId, signal = this.abort.signal): string {
    if (this.stopped || !expected || expected !== this.accountId || signal !== this.abort.signal || signal.aborted) throw new ChannelError('Подключение Slack изменилось. Подключите Slack и обновите каталог.');
    return expected;
  }

  private nextCursor(data: Json): string | undefined {
    const cursor = data.response_metadata?.next_cursor;
    if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 2000 || /[\x00-\x1f]/u.test(cursor))) throw new ChannelError('Slack вернул некорректную страницу каталога.');
    return typeof cursor === 'string' && cursor.trim() ? cursor : undefined;
  }

  private setAvailability(chatId: string, available: boolean, accountId: string, signal: AbortSignal): void {
    this.requireAccount(accountId, signal);
    if (!available) this.conversations.delete(chatId);
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.accountId !== accountId || endpoint.chatId !== chatId || endpoint.available === available) continue;
      this.requireAccount(accountId, signal);
      const updated = { ...endpoint, available, updatedAt: new Date().toISOString() };
      this.endpoints.set(updated.id, updated);
      this.callbacks.endpoint(updated);
    }
  }

  private async conversationPage(cursor?: string): Promise<CatalogPage<Json>> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    const types = CONVERSATION_TYPES.filter(([, scope]) => this.catalogScopes === undefined || this.catalogScopes.has(scope));
    const missing = CONVERSATION_TYPES.filter(([, scope]) => this.catalogScopes !== undefined && !this.catalogScopes.has(scope)).map(([, scope]) => scope);
    if (!types.length) throw new ChannelError(`Для каталога Slack не выданы разрешения ${missing.join(', ')}. Обновите разрешения приложения в workspace.`);
    const warning = missing.length ? `Каталог Slack частичный: не выданы разрешения ${missing.join(', ')}. Чтобы добавить остальные типы чатов, обновите разрешения приложения в workspace.` : undefined;
    const data = await this.api('users.conversations', {
      types: types.map(([type]) => type).join(','), exclude_archived: true, limit: 100, ...(cursor ? { cursor } : {}),
    });
    this.requireAccount(accountId, signal);
    if (!Array.isArray(data.channels)) throw new ChannelError('Slack вернул неразборчивый каталог разговоров.');
    // This method establishes bot membership; conversations.info alone does not.
    const items = data.channels.filter((channel: Json) => channel && typeof channel.id === 'string' && channel.is_archived !== true && channel.is_member !== false);
    for (const conversation of items) {
      this.conversations.set(conversation.id, conversation);
      this.setAvailability(conversation.id, true, accountId, signal);
    }
    return { items, nextCursor: this.nextCursor(data), ...(warning ? { warning } : {}) };
  }

  private async requireConversation(chatId: string): Promise<Json> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    if (!/^[CDG][A-Z0-9]+$/u.test(chatId)) throw new ChannelError('Некорректный разговор Slack.');
    if (this.conversations.has(chatId)) return this.conversations.get(chatId)!;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.conversationPage(cursor);
      this.requireAccount(accountId, signal);
      if (this.conversations.has(chatId)) return this.conversations.get(chatId)!;
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ChannelError('Slack повторил страницу каталога. Обновите каталог.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const scopes = chatId.startsWith('D') ? ['im:read'] : chatId.startsWith('C') ? ['channels:read', 'groups:read'] : ['groups:read', 'mpim:read'];
    const missing = scopes.filter(scope => this.catalogScopes !== undefined && !this.catalogScopes.has(scope));
    if (missing.length) throw new ChannelError(`Не удалось проверить доступ к разговору Slack: не выданы разрешения ${missing.join(', ')}. Обновите разрешения приложения в workspace.`);
    this.setAvailability(chatId, false, accountId, signal);
    throw new ChannelError('Разговор недоступен боту Slack. Добавьте Rele в разговор и обновите каталог.');
  }

  private async person(userId: string): Promise<Person | undefined> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    if (!SLACK_USER.test(userId) || userId === this.botUserId || userId === 'USLACKBOT') return;
    let user = this.profiles.get(userId);
    if (!user) {
      user = (await this.api('users.info', { user: userId })).user;
      this.requireAccount(accountId, signal);
      if (!user || user.id !== userId) throw new ChannelError('Slack не подтвердил сведения об участнике.');
      this.profiles.set(userId, user);
    }
    if (user.deleted) return;
    const person: Person = { id: userId, name: readableTitle(user.profile?.display_name || user.profile?.real_name || user.real_name || user.name, 'Участник Slack'),
      ...(user.is_bot || user.is_app_user || this.people.get(userId)?.isBot ? { isBot: true } : user.is_bot === false ? { isBot: false } : {}) };
    this.people.set(userId, person);
    return person;
  }

  private async peoplePage(conversation: Json, cursor?: string): Promise<CatalogPage<Person>> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    if (conversation.is_im) {
      if (typeof conversation.user !== 'string' || !conversation.user) {
        const data = await this.api('conversations.info', { channel: conversation.id });
        this.requireAccount(accountId, signal);
        const detail = data.channel;
        if (!detail || detail.id !== conversation.id || detail.is_im !== true || typeof detail.user !== 'string' || !detail.user) throw new ChannelError('Slack не сообщил участника личного разговора.');
        conversation.user = detail.user;
      }
      const person = await this.person(conversation.user);
      this.requireAccount(accountId, signal);
      return { items: person ? [person] : [] };
    }
    const data = await this.api('conversations.members', { channel: conversation.id, limit: 20, ...(cursor ? { cursor } : {}) });
    this.requireAccount(accountId, signal);
    if (!Array.isArray(data.members) || data.members.some((id: unknown) => typeof id !== 'string')) throw new ChannelError('Slack вернул неразборчивый список участников.');
    const items: Person[] = [];
    for (const id of new Set<string>(data.members)) {
      this.requireAccount(accountId, signal);
      const person = await this.person(id);
      if (person) items.push(person);
    }
    this.requireAccount(accountId, signal);
    return { items, nextCursor: this.nextCursor(data) };
  }

  private async conversationName(conversation: Json): Promise<string> {
    const accountId = this.requireAccount();
    const signal = this.abort.signal;
    let name: string;
    if (conversation.is_im) name = (await this.peoplePage(conversation)).items[0]?.name ?? 'Личные сообщения';
    else if (conversation.is_mpim) {
      const people = await this.peoplePage(conversation);
      name = readableTitle(people.items.map(person => person.name).join(', '), 'Групповой чат');
    } else name = `#${readableTitle(conversation.name, 'Канал Slack')}`;
    this.requireAccount(accountId, signal);
    this.channelNames.set(conversation.id, name);
    return name;
  }

  deliveryText(delivery: Delivery): string {
    const text = formatSlackReply(delivery.body);
    return delivery.kind === 'message' && delivery.mentions?.length ? `${delivery.mentions.map(person => `<@${person.id}>`).join(' ')}\n\n${text}` : text;
  }
  async deliver(delivery: Delivery, approval?: Approval): Promise<string> {
    if (!this.accountId || delivery.origin.accountId !== this.accountId) throw new ChannelError('Учётная запись Slack изменилась. Доставка через другого бота запрещена.');
    const rich = (delivery.kind === 'answer' || delivery.kind === 'message') && !approval;
    const formatted = rich ? formatSlackReply(delivery.body) : delivery.body;
    if (delivery.kind === 'message' && (approval || [...delivery.body].length > 3000 || delivery.mentions?.some(person => !SLACK_USER.test(person.id)))) throw new ChannelError('Некорректное сообщение или адрес упоминания Slack.');
    const body: Json = {
      channel: delivery.origin.chatId, thread_ts: delivery.origin.threadId,
      text: escapeSlackText(formatted),
      mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
    };
    // Native Markdown blocks preserve tables; the escaped text remains the notification fallback.
    if (rich) body.blocks = [{ type: 'markdown', text: formatted }];
    if (delivery.kind === 'message' && delivery.mentions?.length) {
      const mentions = delivery.mentions.map(person => `<@${person.id}>`).join(' ');
      if (mentions.length > 3000) throw new ChannelError('Список упоминаний превышает размер блока Slack.');
      body.blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: mentions, verbatim: true } });
    }
    if (approval && !approval.questions?.length) body.blocks = [
      // 1450 code points fit within 2900 UTF-16 units even when every character is an emoji.
      ...splitReply(delivery.body, 1450).map(text => ({ type: 'section', text: { type: 'plain_text', text } })),
      { type: 'actions', elements: ['accept', 'decline'].map(decision => ({
        type: 'button', action_id: `rele_${decision}`, text: { type: 'plain_text', text: decision === 'accept' ? 'Разрешить' : 'Отклонить' }, value: `rele:${approval.id}:${decision}`,
      })) },
    ];
    const result = await this.api('chat.postMessage', body, this.botToken, true);
    if (typeof result.ts !== 'string' || result.channel !== delivery.origin.chatId) throw new ChannelError('Slack не подтвердил адрес и идентификатор отправленного сообщения. Проверьте доставку.', false, true);
    return result.ts;
  }

  async download(audio: AudioAttachment, file: string): Promise<void> {
    let url: URL;
    try { url = new URL(audio.url ?? ''); } catch { throw new ChannelError('У аудиофайла Slack нет доступного адреса.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || !url.pathname.startsWith('/files-pri/') || url.username || url.password || url.port) throw new ChannelError('Недопустимый адрес аудиофайла Slack.');
    if ((audio.size ?? 0) > 20 * 1024 * 1024) throw new ChannelError('Аудиофайл превышает 20 МБ.');
    let response: Response;
    try { response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.botToken}` }, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]) }); }
    catch { throw new ChannelError('Не удалось скачать аудиофайл Slack.'); }
    await downloadBounded(response, file);
  }

  private async receive(raw: string, socket: WebSocket): Promise<void> {
    let envelope: Json;
    try { envelope = JSON.parse(raw); } catch { return; }
    if (envelope.type === 'disconnect') { socket.close(); return; }
    if (typeof envelope.envelope_id !== 'string') return;
    if (envelope.type === 'events_api') {
      const payload = envelope.payload as Json;
      if (payload?.team_id && payload.team_id !== this.teamId) return;
      const event = payload?.event;
      if (event?.type === 'agent_session_stopped') {
        if (payload.team_id === this.teamId && typeof payload.event_id === 'string' && payload.event_id
            && typeof event.channel === 'string' && /^[CDG][A-Z0-9]+$/u.test(event.channel)
            && typeof event.thread_ts === 'string' && SLACK_TS.test(event.thread_ts)
            && typeof event.event_ts === 'string' && SLACK_TS.test(event.event_ts)
            && typeof event.user === 'string' && SLACK_USER.test(event.user)) {
          const endpoint = this.endpoints.get(endpointId('slack', this.accountId, event.channel, event.thread_ts));
          const actor = await this.person(event.user).catch(() => undefined);
          if (endpoint && actor?.isBot !== true) await this.callbacks.message({
            control: 'stop', eventId: `agent-session-stopped:${payload.event_id}`, endpoint,
            sender: actor ?? { id: event.user, name: 'Участник Slack' },
            messageId: event.event_ts, text: '',
          });
        }
        this.ack(socket, envelope.envelope_id);
        return;
      }
      const source = event && ['message', 'app_mention'].includes(event.type) ? this.messageSource(event, event.channel) : undefined;
      if (source) {
        if (typeof source.message.user === 'string' && SLACK_USER.test(source.message.user)) await this.person(source.message.user).catch(() => undefined);
        const message = this.normalize(source.message, source.kind);
        await this.callbacks.message(message);
        this.ack(socket, envelope.envelope_id);
        void this.refreshNames(source.message, message.endpoint).catch(() => {});
        return;
      }
    } else if (envelope.type === 'interactive' && envelope.payload?.type === 'block_actions') {
      const payload = envelope.payload as Json;
      const value = payload.actions?.[0]?.value;
      const match = typeof value === 'string' ? /^rele:([a-f0-9-]{36}):(accept|decline)$/u.exec(value) : null;
      if (match && payload.user?.id && payload.channel?.id && (!payload.team?.id || payload.team.id === this.teamId)) {
        try {
          const actor = await this.person(payload.user.id);
          if (actor?.isBot !== true) await this.callbacks.action({ approvalId: match[1], decision: match[2] as 'accept' | 'decline', platform: 'slack', accountId: this.accountId, chatId: payload.channel.id, threadId: payload.message?.thread_ts ?? payload.message?.ts, senderId: payload.user.id,
            ...(actor?.isBot === false ? { senderIsBot: false } : {}) });
        } catch (error) { if (error instanceof ChannelError && error.retryable) throw error; }
      }
    }
    this.ack(socket, envelope.envelope_id);
  }

  private messageSource(raw: Json, channel: string): { message: Json; kind: SlackTranscriptMessage['kind'] } | undefined {
    if (!raw || typeof raw !== 'object' || typeof channel !== 'string' || !/^[CDG][A-Z0-9]+$/u.test(channel)) return;
    const kind = raw.subtype === 'message_deleted' ? 'deleted' : raw.subtype === 'message_changed' || raw.edited ? 'edit' : 'message';
    const inner = raw.subtype === 'message_changed' ? raw.message : raw.subtype === 'message_deleted' ? raw.previous_message ?? { ts: raw.deleted_ts } : raw;
    if (!inner || typeof inner !== 'object' || (inner.channel && inner.channel !== channel) || (inner.team && inner.team !== this.teamId)) return;
    const ts = raw.subtype === 'message_deleted' ? raw.deleted_ts ?? inner.ts : inner.ts;
    if (typeof ts !== 'string' || !SLACK_TS.test(ts) || (inner.ts && inner.ts !== ts) || (inner.thread_ts && (typeof inner.thread_ts !== 'string' || !SLACK_TS.test(inner.thread_ts)))) return;
    return { message: { ...inner, type: 'message', channel, ts, ...(kind === 'deleted' ? { subtype: 'message_deleted' } : {}) }, kind };
  }

  private transcript(event: Json, kind: SlackTranscriptMessage['kind'], id: string): SlackTranscriptMessage {
    const userId = typeof event.user === 'string' && SLACK_USER.test(event.user) ? event.user : '';
    const cached = this.people.get(userId);
    const remembered = this.endpoints.get(id)?.people.find(person => person.id === userId);
    const profile = this.profiles.get(userId);
    const isBot = userId === this.botUserId || !!(event.bot_id || event.app_id || event.subtype === 'bot_message' || cached?.isBot || remembered?.isBot || profile?.is_bot || profile?.is_app_user);
    const sender: Person = { id: userId || (typeof event.bot_id === 'string' && SLACK_BOT.test(event.bot_id) ? `bot:${event.bot_id}` : 'slack:unknown'), name: cached?.name || remembered?.name || readableTitle(event.username, isBot ? 'Бот Slack' : 'Участник Slack'),
      ...(isBot ? { isBot: true } : cached?.isBot === false || profile?.is_bot === false ? { isBot: false } : {}) };
    return { endpointId: id, accountId: this.accountId, chatId: event.channel, threadId: event.thread_ts || event.ts, messageId: event.ts, sender, text: messageText(event), payload: transcriptPayload(event), kind };
  }

  private normalize(event: Json, kind: SlackTranscriptMessage['kind']): InboundMessage {
    const threadId = String(event.thread_ts || event.ts);
    const id = endpointId('slack', this.accountId, event.channel, threadId);
    const previous = this.endpoints.get(id);
    const slack = this.transcript(event, kind, id);
    const person = slack.sender;
    const text = slack.text;
    const directMention = typeof event.text === 'string' && hasDirectMention(event.text, this.botUserId) || hasBlockMention(event.blocks, this.botUserId);
    const stableUser = typeof event.user === 'string' && SLACK_USER.test(event.user);
    const stableBot = typeof event.bot_id === 'string' && SLACK_BOT.test(event.bot_id);
    const self = person.id === this.botUserId || stableBot && event.bot_id === this.botId;
    if (stableUser && person.isBot) this.people.set(person.id, person);
    const endpoint: Endpoint = {
      ...previous,
      id, platform: 'slack', accountId: this.accountId, chatId: event.channel, threadId,
      title: previous?.title ?? readableTitle(text.replaceAll(`<@${this.botUserId}>`, '').trim(), 'Обсуждение Slack'),
      subtitle: previous?.subtitle ?? `${this.teamName} · ${this.channelNames.get(event.channel) ?? 'Канал Slack'}`,
      url: `slack://channel?team=${encodeURIComponent(this.teamId)}&id=${encodeURIComponent(event.channel)}&message=${encodeURIComponent(threadId)}`,
      people: [...new Map([...(previous?.people ?? []), ...(stableUser ? [person] : [])].filter(value => SLACK_USER.test(value.id) && value.id !== this.botUserId && value.id !== 'USLACKBOT').map(value => [value.id, value])).values()], updatedAt: new Date().toISOString(),
    };
    this.endpoints.set(id, endpoint);
    const file = (Array.isArray(event.files) ? event.files : []).find((entry: Json) => String(entry.mimetype).startsWith('audio/') && entry.url_private_download);
    return {
      // app_mention and message may describe the same message with distinct envelope/event IDs.
      eventId: `message:${event.channel}:${event.ts}${kind === 'message' ? '' : `:${kind}:${createHash('sha256').update(JSON.stringify(slack.payload)).digest('hex').slice(0, 16)}`}`, endpoint, sender: person, messageId: event.ts, text, slack, directMention,
      contextOnly: kind !== 'message' || !!event.subtype && !['file_share', 'bot_message', 'me_message', 'thread_broadcast'].includes(event.subtype)
        || !(stableUser || stableBot && !!this.botId) || self || person.id === 'USLACKBOT' || !text && !file,
      ...(file ? { audio: { platform: 'slack' as const, fileId: String(file.id), url: file.url_private_download, name: readableTitle(file.name, 'audio'), mimeType: file.mimetype, size: file.size } } : {}),
    };
  }

  private async refreshNames(event: Json, endpoint: Endpoint): Promise<void> {
    if (this.refreshing.has(endpoint.id) || this.stopped) return;
    const signal = this.abort.signal;
    this.refreshing.add(endpoint.id);
    try {
      const results = await Promise.allSettled([
        typeof event.user === 'string' && SLACK_USER.test(event.user) && !this.profiles.has(event.user) ? this.person(event.user) : Promise.resolve(null),
        this.channelNames.has(event.channel) ? Promise.resolve(null) : this.api('conversations.info', { channel: event.channel }),
        endpoint.title === 'Обсуждение Slack' ? this.api('conversations.replies', { channel: event.channel, ts: endpoint.threadId, limit: 1 }) : Promise.resolve(null),
      ]);
      if (this.stopped || endpoint.accountId !== this.accountId || signal !== this.abort.signal || signal.aborted) return;
      const channel = results[1].status === 'fulfilled' ? results[1].value?.channel : null;
      if (channel) this.channelNames.set(event.channel, channel.is_im ? 'Личные сообщения' : `#${readableTitle(channel.name, 'Канал Slack')}`);
      const root = results[2].status === 'fulfilled' ? results[2].value?.messages?.[0] : null;
      const current = this.endpoints.get(endpoint.id) ?? endpoint;
      const updated = { ...current, title: root ? readableTitle(root.text, current.title) : current.title, subtitle: `${this.teamName} · ${this.channelNames.get(event.channel) ?? 'Канал Slack'}`, people: current.people.map(person => this.people.get(person.id) ?? person), updatedAt: new Date().toISOString() };
      this.endpoints.set(updated.id, updated);
      if (!this.stopped) this.callbacks.endpoint(updated);
    } finally { this.refreshing.delete(endpoint.id); }
  }

  private async api(method: string, body: Json, token = this.botToken, sending = false): Promise<Json> {
    const accountId = this.accountId;
    const signal = this.abort.signal;
    let response: Response;
    // These Slack read methods ignore JSON arguments on the live bot API.
    const form = ['users.conversations', 'conversations.members', 'users.info', 'conversations.replies'].includes(method);
    const payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    try { response = await this.fetcher(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': form ? 'application/x-www-form-urlencoded; charset=utf-8' : 'application/json; charset=utf-8' }, body: payload, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }); }
    catch { throw new ChannelError('Соединение со Slack прервано.', !sending, sending); }
    const retrySeconds = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.max(1000, Math.min(3600_000, retrySeconds * 1000)) : 30_000;
    if (response.status === 429) throw new ChannelError('Slack ограничил частоту запросов. Повторите загрузку позже.', true, false, retryAfterMs, 429);
    let data: Json;
    try { data = await response.json() as Json; } catch { throw new ChannelError('Slack вернул неразборчивое подтверждение.', !sending, sending); }
    if (!response.ok || data.ok !== true) {
      if (data.error === 'ratelimited') throw new ChannelError('Slack ограничил частоту запросов. Повторите загрузку позже.', true, false, retryAfterMs, 429);
      if (['conversations.history', 'conversations.members', 'conversations.replies'].includes(method) && typeof body.channel === 'string' && ['not_in_channel', 'channel_not_found', 'is_archived', 'no_permission'].includes(data.error)) {
        this.setAvailability(body.channel, false, accountId, signal);
      }
      const known: Record<string, string> = { invalid_auth: 'Неверный токен Slack.', token_revoked: 'Токен Slack отозван.', missing_scope: 'Приложению Slack не хватает разрешений. Обновите разрешения и переустановите приложение в workspace.', not_in_channel: 'Добавьте бота Slack в канал.', channel_not_found: 'Канал Slack недоступен.', no_permission: 'Боту Slack недоступен этот разговор.', not_allowed_token_type: 'Неподдерживаемый тип токена Slack.', user_not_found: 'Участник Slack недоступен.', account_inactive: 'Учётная запись Slack отключена.', is_archived: 'Канал Slack архивирован.' };
      throw new ChannelError(known[data.error] ?? 'Slack отклонил запрос.', !sending && response.status >= 500, sending && response.status >= 500);
    }
    if (method === 'auth.test' && token === this.botToken) {
      if (this.stopped || signal !== this.abort.signal || signal.aborted) throw new ChannelError('Подключение Slack изменилось. Подключите Slack и обновите каталог.');
      const scopes = response.headers.get('x-oauth-scopes');
      this.catalogScopes = scopes === null ? undefined : new Set(scopes.split(',').map(scope => scope.trim()));
    }
    return data;
  }

  private ack(socket: WebSocket, id: string): void { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: id })); }
  private setState(patch: Partial<ConnectionState>): void { this.state = { ...this.state, ...patch }; this.callbacks.status(); }
  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => {}); }, Math.min(60_000, 1000 * 2 ** Math.min(this.retries++, 6)));
    this.retry.unref();
  }
}

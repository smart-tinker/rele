import WebSocket from 'ws';
import type { Approval, AudioAttachment, ConnectionState, Delivery, Endpoint, InboundMessage, Person } from '../../shared/types.js';
import { ChannelError, downloadBounded, endpointId, readableTitle, type Channel, type ChannelCallbacks } from './common.js';

type Json = Record<string, any>;
export interface SlackOptions {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  knownEndpoints?: Endpoint[];
}

/** Socket Mode needs outbound connections only. ACK follows the durable inbox write. */
export class SlackChannel implements Channel {
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
  private accountId = '';
  private teamName = 'Slack';
  private processing: Promise<void> = Promise.resolve();
  private endpoints = new Map<string, Endpoint>();
  private people = new Map<string, Person>();
  private channelNames = new Map<string, string>();
  private refreshing = new Set<string>();
  private abort = new AbortController();

  constructor(private readonly botToken: string, private readonly appToken: string, private readonly callbacks: ChannelCallbacks, private readonly options: SlackOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    for (const endpoint of options.knownEndpoints ?? []) if (endpoint.platform === 'slack') {
      this.endpoints.set(endpoint.id, endpoint);
      for (const person of endpoint.people) this.people.set(person.id, person);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.abort = new AbortController();
    clearTimeout(this.retry);
    try {
      const identity = await this.api('auth.test', {});
      if (!identity.team_id || !identity.user_id) throw new ChannelError('Slack не сообщил учётную запись бота.');
      this.teamId = identity.team_id;
      this.botUserId = identity.user_id;
      this.accountId = `${this.teamId}:${this.botUserId}`;
      this.teamName = readableTitle(identity.team, 'Slack');
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

  async deliver(delivery: Delivery, approval?: Approval): Promise<string> {
    if (!this.accountId || delivery.origin.accountId !== this.accountId) throw new ChannelError('Учётная запись Slack изменилась. Доставка через другого бота запрещена.');
    const body: Json = {
      channel: delivery.origin.chatId, thread_ts: delivery.origin.threadId,
      text: delivery.body.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'),
      mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
    };
    if (approval && !approval.questions?.length) body.blocks = [
      { type: 'section', text: { type: 'plain_text', text: delivery.body.slice(0, 2900) } },
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
      if (event && ['message', 'app_mention'].includes(event.type) && event.user && event.user !== this.botUserId && !event.bot_id && (!event.subtype || event.subtype === 'file_share') && event.channel && event.ts) {
        const message = this.normalize(event);
        if (message.text.trim() || message.audio) await this.callbacks.message(message);
        else this.callbacks.endpoint(message.endpoint);
        this.ack(socket, envelope.envelope_id);
        void this.refreshNames(event, message.endpoint).catch(() => {});
        return;
      }
    } else if (envelope.type === 'interactive' && envelope.payload?.type === 'block_actions') {
      const payload = envelope.payload as Json;
      const value = payload.actions?.[0]?.value;
      const match = typeof value === 'string' ? /^rele:([a-f0-9-]{36}):(accept|decline)$/u.exec(value) : null;
      if (match && payload.user?.id && payload.channel?.id && (!payload.team?.id || payload.team.id === this.teamId)) {
        try {
          await this.callbacks.action({ approvalId: match[1], decision: match[2] as 'accept' | 'decline', platform: 'slack', accountId: this.accountId, chatId: payload.channel.id, threadId: payload.message?.thread_ts ?? payload.message?.ts, senderId: payload.user.id });
        } catch (error) { if (error instanceof ChannelError && error.retryable) throw error; }
      }
    }
    this.ack(socket, envelope.envelope_id);
  }

  private normalize(event: Json): InboundMessage {
    const threadId = String(event.thread_ts || event.ts);
    const id = endpointId('slack', this.accountId, event.channel, threadId);
    const previous = this.endpoints.get(id);
    const person = this.people.get(event.user) ?? { id: event.user, name: 'Участник Slack' };
    const text = String(event.text ?? '').replaceAll(`<@${this.botUserId}>`, '').trim().slice(0, 50_000);
    const endpoint: Endpoint = {
      id, platform: 'slack', accountId: this.accountId, chatId: event.channel, threadId,
      title: previous?.title ?? readableTitle(event.thread_ts && event.thread_ts !== event.ts ? '' : text, 'Обсуждение Slack'),
      subtitle: previous?.subtitle ?? `${this.teamName} · ${this.channelNames.get(event.channel) ?? 'Канал Slack'}`,
      url: `slack://channel?team=${encodeURIComponent(this.teamId)}&id=${encodeURIComponent(event.channel)}&message=${encodeURIComponent(threadId)}`,
      people: [...new Map([...(previous?.people ?? []), person].map(value => [value.id, value])).values()], updatedAt: new Date().toISOString(),
    };
    this.endpoints.set(id, endpoint);
    const file = (Array.isArray(event.files) ? event.files : []).find((entry: Json) => String(entry.mimetype).startsWith('audio/') && entry.url_private_download);
    return {
      // app_mention and message may describe the same message with distinct envelope/event IDs.
      eventId: `message:${event.channel}:${event.ts}`, endpoint, sender: person, messageId: event.ts, text,
      ...(file ? { audio: { platform: 'slack' as const, fileId: String(file.id), url: file.url_private_download, name: readableTitle(file.name, 'audio'), mimeType: file.mimetype, size: file.size } } : {}),
    };
  }

  private async refreshNames(event: Json, endpoint: Endpoint): Promise<void> {
    if (this.refreshing.has(endpoint.id) || this.stopped) return;
    this.refreshing.add(endpoint.id);
    try {
      const results = await Promise.allSettled([
        this.people.has(event.user) ? Promise.resolve(null) : this.api('users.info', { user: event.user }),
        this.channelNames.has(event.channel) ? Promise.resolve(null) : this.api('conversations.info', { channel: event.channel }),
        endpoint.title === 'Обсуждение Slack' ? this.api('conversations.replies', { channel: event.channel, ts: endpoint.threadId, limit: 1 }) : Promise.resolve(null),
      ]);
      const user = results[0].status === 'fulfilled' ? results[0].value?.user : null;
      if (user) this.people.set(event.user, { id: event.user, name: readableTitle(user.profile?.display_name || user.profile?.real_name || user.real_name || user.name, 'Участник Slack') });
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
    let response: Response;
    try { response = await this.fetcher(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]) }); }
    catch { throw new ChannelError('Соединение со Slack прервано.', !sending, sending); }
    if (response.status === 429) throw new ChannelError('Slack ограничил частоту запросов.', true, false, Math.max(1000, Math.min(3600_000, Number(response.headers.get('retry-after') || 30) * 1000)));
    let data: Json;
    try { data = await response.json() as Json; } catch { throw new ChannelError('Slack вернул неразборчивое подтверждение.', !sending, sending); }
    if (!response.ok || data.ok !== true) {
      if (data.error === 'ratelimited') throw new ChannelError('Slack ограничил частоту запросов.', true);
      const known: Record<string, string> = { invalid_auth: 'Неверный токен Slack.', token_revoked: 'Токен Slack отозван.', missing_scope: 'Приложению Slack не хватает разрешений.', not_in_channel: 'Добавьте бота Slack в канал.', channel_not_found: 'Канал Slack недоступен.', account_inactive: 'Учётная запись Slack отключена.', is_archived: 'Канал Slack архивирован.' };
      throw new ChannelError(known[data.error] ?? 'Slack отклонил запрос.', !sending && response.status >= 500, sending && response.status >= 500);
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

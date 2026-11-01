import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Approval, Delivery, Endpoint, InboundMessage } from '../src/shared/types.js';
import { SlackChannel } from '../src/server/channels/slack.js';
import { QUESTION_VIEW } from '../src/server/channels/slack-questions.js';
import { Store } from '../src/server/store.js';
import {
  ChannelError,
  endpointId,
  type ChannelCallbacks,
} from '../src/server/channels/common.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  ping = vi.fn();
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  receive(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

const live: SlackChannel[] = [];
const files: string[] = [];
afterEach(async () => {
  for (const channel of live.splice(0)) await channel.stop();
  for (const directory of files.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function makeChannel(
  options: {
    message?: ChannelCallbacks['message'];
    action?: ChannelCallbacks['action'];
    question?: ChannelCallbacks['question'];
    postMessage?: () => Promise<Response>;
    api?: (method: string, body: Record<string, unknown>) => Response | undefined | Promise<Response | undefined>;
    knownEndpoints?: Endpoint[];
    progressStore?: Pick<Store, 'getMeta' | 'setMeta'>;
  } = {},
) {
  const socket = new FakeSocket();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const endpoints = vi.fn<ChannelCallbacks['endpoint']>();
  const message =
    options.message ??
    vi.fn<ChannelCallbacks['message']>().mockResolvedValue(undefined);
  const action =
    options.action ??
    vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
  const status = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const form = new Headers(init?.headers).get('content-type')?.startsWith('application/x-www-form-urlencoded');
      const body = form ? Object.fromEntries(new URLSearchParams(String(init?.body))) : init?.body ? JSON.parse(String(init.body)) : {};
      const override = await options.api?.(url.split('/').at(-1)!, body);
      if (override) return override;
      if (url === 'https://slack.com/api/auth.test')
        return Response.json({
          ok: true,
          team_id: 'TEXAMPLE',
          user_id: 'UBOT',
          bot_id: 'BSELF',
          team: 'Пример команды',
        });
      if (url === 'https://slack.com/api/apps.connections.open')
        return Response.json({
          ok: true,
          url: 'wss://wss-primary.slack.com/link?ticket=synthetic-only',
        });
      if (url === 'https://slack.com/api/users.info')
        return Response.json({
          ok: true,
          user: { id: 'UANNA', is_bot: false, profile: { display_name: 'Анна (пример)' } },
        });
      if (url === 'https://slack.com/api/conversations.info')
        return Response.json({
          ok: true,
          channel: { id: 'CEXAMPLE', name: 'example' },
        });
      if (url === 'https://slack.com/api/conversations.replies')
        return Response.json({
          ok: true,
          messages: [{ text: 'Пример: вопрос API' }],
        });
      if (url === 'https://slack.com/api/chat.postMessage')
        return options.postMessage
          ? options.postMessage()
          : Response.json({ ok: true, ts: '1000.2000', channel: 'CEXAMPLE' });
      if (url.startsWith('https://files.slack.com/files-pri/'))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'audio/ogg', 'content-length': '3' },
        });
      throw new Error(`Unexpected URL in isolated Slack test: ${url}`);
    });
  const channel = new SlackChannel(
    'SLACK_TOKEN_PLACEHOLDER_4051722',
    'SLACK_TOKEN_PLACEHOLDER_6612940',
    { message, endpoint: endpoints, action, question: options.question, status },
    {
      fetch: fetcher,
      knownEndpoints: options.knownEndpoints,
      progressStore: options.progressStore,
      socket: () => {
        queueMicrotask(() => socket.emit('open'));
        return socket as unknown as WebSocket;
      },
    },
  );
  live.push(channel);
  await channel.start();
  return { channel, socket, calls, fetcher, endpoints, message, action, status };
}

function envelope(
  id: string,
  type: 'message' | 'app_mention' = 'message',
  extra: Record<string, unknown> = {},
) {
  return {
    envelope_id: id,
    type: 'events_api',
    payload: {
      team_id: 'TEXAMPLE',
      event_id: `outer-${id}`,
      event: {
        type,
        user: 'UANNA',
        channel: 'CEXAMPLE',
        ts: '1000.1001',
        thread_ts: '1000.1000',
        text: '<@UBOT> Пример сообщения',
        ...extra,
      },
    },
  };
}

function delivery(accountId = 'TEXAMPLE:UBOT'): Delivery {
  return {
    id: 'delivery-example',
    requestId: 'request-example',
    origin: {
      platform: 'slack',
      accountId,
      endpointId: 'endpoint-example',
      chatId: 'CEXAMPLE',
      threadId: '1000.1000',
      senderId: 'UANNA',
      senderName: 'Анна (пример)',
      messageId: '1000.1001',
    },
    key: 'part-0',
    ordinal: 0,
    kind: 'answer',
    body: 'Пример <@everyone> & ответ',
    status: 'sending',
    attempts: 1,
    createdAt: '2026-10-18T20:00:00Z',
    updatedAt: '2026-10-18T20:00:00Z',
  };
}

function progressFixture() {
  const origin = delivery().origin;
  origin.endpointId = endpointId('slack', origin.accountId, origin.chatId, origin.threadId);
  const endpoint: Endpoint = { id: origin.endpointId, platform: 'slack', accountId: origin.accountId,
    chatId: origin.chatId, threadId: origin.threadId, title: 'Тестовый тред', subtitle: 'Slack', people: [], updatedAt: '2026-10-27T00:00:00Z' };
  const meta = new Map<string, string>();
  const progressStore = { getMeta: (key: string) => meta.get(key), setMeta: (key: string, value: string) => { meta.set(key, value); } };
  return { origin, endpoint, meta, progressStore };
}

function questionApproval(method = 'item/tool/requestUserInput'): Approval {
  return { id: '12345678-1234-1234-1234-123456789abc', requestId: 'request-example', turnId: 'turn-example', itemId: 'question-item',
    rpcId: method === 'rele/asyncUserInput' ? null : 'question-rpc', method, title: 'Codex ждёт уточнения', details: 'Выберите ветку', status: 'pending',
    questions: [{ id: 'branch', header: 'Ветка', question: 'С какой веткой работать?', options: [
      { label: 'main', description: 'Основная ветка' }, { label: 'develop', description: 'Ветка разработки' },
    ] }], createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
}
function questionDelivery(approval: Approval): Delivery {
  return { ...delivery(), kind: 'approval', approvalId: approval.id, body: [approval.title, ...(approval.questions ?? []).map(question =>
    `${question.header}: ${question.question}\n${(question.options ?? []).map(option => `${option.label} — ${option.description}`).join('\n')}`)].join('\n\n') };
}
function questionInteraction(id: string, action: Record<string, unknown>) {
  return { envelope_id: id, type: 'interactive', payload: { type: 'block_actions', team: { id: 'TEXAMPLE' }, user: { id: 'UANNA' },
    channel: { id: 'CEXAMPLE' }, message: { ts: '1000.2000', thread_ts: '1000.1000' }, trigger_id: 'synthetic-trigger', actions: [action] } };
}
const questionApi = (method: string, body: Record<string, unknown>) => method === 'views.open' ? Response.json({ ok: true, view: { id: 'VMODAL' } })
  : method === 'chat.postEphemeral' ? Response.json({ ok: true, message_ts: '1000.3000' })
    : method === 'chat.update' ? Response.json({ ok: true, channel: body.channel, ts: body.ts }) : undefined;

describe('Slack question choices and forms', () => {
  it('repairs a stale bot account and accepts its human question action after an app-assisted file share', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT',
      chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UANNA', name: 'Stale bot flag', isBot: true }], updatedAt: '2026-10-20T00:00:00Z' };
    const approval = questionApproval(), action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket, message } = await makeChannel({ knownEndpoints: [known], question: () => approval, action,
      api: (method, body) => method === 'users.info' ? Response.json({ ok: true, user: { id: 'UANNA', is_bot: false, is_app_user: false,
        profile: { display_name: 'Verified human' } } }) : method === 'users.conversations' ? Response.json({ ok: true, channels: [{ id: 'CEXAMPLE', is_member: true }] })
          : method === 'conversations.members' ? Response.json({ ok: true, members: ['UANNA'] }) : questionApi(method, body) });
    socket.receive(envelope('human-before', 'message', { ts: '1000.1001' }));
    socket.receive(envelope('human-file', 'message', { ts: '1000.1002', subtype: 'file_share', app_id: 'AHELPER' }));
    socket.receive(envelope('human-after', 'message', { ts: '1000.1003' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(3));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received.map(value => value.sender.isBot)).toEqual([false, true, false]);
    for (const value of received) expect(value.endpoint.people).toContainEqual({ id: 'UANNA', name: 'Verified human', isBot: false });
    expect((await channel.listPeople('CEXAMPLE')).items).toEqual([{ id: 'UANNA', name: 'Verified human', isBot: false }]);
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    socket.receive(questionInteraction('human-choice', post.blocks.at(-1).elements[0]));
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'UANNA', senderIsBot: false, answers: { branch: ['main'] } }));
  });

  it.each([
    ['verified bot', { is_bot: true, is_app_user: false }, false, true],
    ['verified app user', { is_bot: false, is_app_user: true }, false, true],
    ['unknown profile with a remembered bot', {}, true, true],
    ['unknown profile without a classification', {}, undefined, undefined],
  ] as const)('never grants human question authority to %s', async (_name, flags, rememberedBot, expectedBot) => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT',
      chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UANNA', name: 'Known participant',
        ...(rememberedBot === undefined ? {} : { isBot: rememberedBot }) }], updatedAt: '2026-10-20T00:00:00Z' };
    const approval = questionApproval(), action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket, message } = await makeChannel({ knownEndpoints: [known], question: () => approval, action,
      api: (method, body) => method === 'users.info' ? Response.json({ ok: true, user: { id: 'UANNA', ...flags,
        profile: { display_name: 'Participant' } } }) : questionApi(method, body) });
    socket.receive(envelope('classified-account'));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0].sender.isBot).toBe(expectedBot);
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    socket.receive(questionInteraction('rejected-account-choice', post.blocks.at(-1).elements[0]));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/chat.postEphemeral'))).toBe(true));
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['item/tool/requestUserInput', 'rele/asyncUserInput'])('shows in-thread choices with exact stored labels for %s', async method => {
    const approval = questionApproval(method);
    approval.questions![0].options![0] = { label: 'Основная ветка', description: 'Полное описание <@UPEER> & подробности' };
    const question = vi.fn<NonNullable<ChannelCallbacks['question']>>().mockReturnValue(approval);
    let finish!: () => void;
    const action = vi.fn<ChannelCallbacks['action']>().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { channel, calls, socket } = await makeChannel({ question, action, api: questionApi });
    const input = questionDelivery(approval);
    await channel.deliver(input, approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    expect(post.blocks.filter((block: { type: string }) => block.type === 'section').map((block: { text: { text: string } }) => block.text.text).join('')).toBe(input.body);
    const buttons = post.blocks.at(-1).elements;
    expect(buttons.map((button: { text: { text: string } }) => button.text.text)).toEqual(['Основная ветка', 'develop', 'Свой ответ']);
    socket.receive(questionInteraction('choice', { ...buttons[0], text: { type: 'plain_text', text: 'FORGED LABEL' } }));
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(socket.sent.map(value => JSON.parse(value).envelope_id)).toContain('choice');
    expect(question).toHaveBeenCalledWith(expect.objectContaining({ approvalId: approval.id, messageId: '1000.2000', accountId: 'TEXAMPLE:UBOT',
      chatId: 'CEXAMPLE', threadId: '1000.1000', senderId: 'UANNA', senderIsBot: false }));
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ decision: 'accept', answers: { branch: [approval.questions![0].options![0].label] } }));
    finish();
  });

  it('opens the existing form for long labels, keeps full wording readable and submits the exact stored choice', async () => {
    const approval = questionApproval('rele/asyncUserInput');
    const label = 'Установить исправление и перезапустить только Rele на Home, сохранив исходный профиль и историю';
    approval.questions![0].options![0] = { label, description: 'Сохранить исходный разговор и настройки' };
    const action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket } = await makeChannel({ question: () => approval, action, api: questionApi });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    const buttons = post.blocks.at(-1).elements;
    expect(buttons.map((button: { text: { text: string } }) => button.text.text)).toEqual(['Ответить']);
    expect(post.blocks.filter((block: { type: string }) => block.type === 'section').map((block: { text: { text: string } }) => block.text.text).join('')).toContain(label);
    socket.receive(questionInteraction('open-long-choice', buttons[0]));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/views.open'))).toBe(true));
    const view = JSON.parse(String(calls.find(call => call.url.endsWith('/views.open'))!.init!.body)).view;
    expect(view.blocks.filter((block: { type: string }) => block.type === 'section').map((block: { text: { text: string } }) => block.text.text).join('')).toContain(`${label} — Сохранить исходный разговор и настройки`);
    const choice = view.blocks.find((block: { block_id?: string }) => block.block_id === 'q0-choice');
    expect(choice.element.options.at(-1)).toEqual({ text: { type: 'plain_text', text: 'Свой ответ' }, value: 'custom' });
    expect(view.blocks.some((block: { block_id?: string }) => block.block_id === 'q0-text')).toBe(true);
    socket.receive({ envelope_id: 'submit-long-choice', type: 'interactive', payload: { type: 'view_submission', team: { id: 'TEXAMPLE' }, user: { id: 'UANNA' },
      view: { ...view, state: { values: { 'q0-choice': { answer: { selected_option: { value: '0', text: { text: 'FORGED LABEL' } } } } } } } } });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'UANNA', senderIsBot: false, answers: { branch: [label] } }));
  });

  it.each(['item/tool/requestUserInput', 'rele/asyncUserInput'])('opens a bound own-answer modal and submits exact answers for %s', async method => {
    const approval = questionApproval(method), question = vi.fn<NonNullable<ChannelCallbacks['question']>>().mockReturnValue(approval);
    approval.questions![0].id = '__proto__';
    let finish!: () => void;
    const action = vi.fn<ChannelCallbacks['action']>().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { channel, calls, socket } = await makeChannel({ question, action, api: questionApi });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    socket.receive(questionInteraction('open-custom', post.blocks.at(-1).elements.at(-1)));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/views.open'))).toBe(true));
    const opened = JSON.parse(String(calls.find(call => call.url.endsWith('/views.open'))!.init!.body));
    expect(opened.trigger_id).toBe('synthetic-trigger');
    expect(JSON.parse(opened.view.private_metadata)).toMatchObject({ approvalId: approval.id, accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE',
      threadId: '1000.1000', messageId: '1000.2000', senderId: 'UANNA', mode: 'custom' });
    expect(opened.view.blocks.filter((block: { type: string }) => block.type === 'input')).toHaveLength(1);
    socket.receive({ envelope_id: 'submit-custom', type: 'interactive', payload: { type: 'view_submission', team: { id: 'TEXAMPLE' }, user: { id: 'UANNA' },
      view: { ...opened.view, state: { values: { 'q0-text': { answer: { type: 'plain_text_input', value: '  feature/пример <@UPEER>  ' } } } } } } });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(socket.sent.map(value => JSON.parse(value))).toContainEqual({ envelope_id: 'submit-custom' });
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ answers: { ['__proto__']: ['  feature/пример <@UPEER>  '] }, messageId: '1000.2000', senderName: 'Анна (пример)' }));
    expect(Object.hasOwn(action.mock.calls[0][0].answers!, '__proto__')).toBe(true);
    finish();
  });

  it('collects every modal question, validates own-answer text and leaves a dismissed form pending', async () => {
    const approval = questionApproval();
    approval.questions!.push({ id: 'mode', header: 'Режим', question: 'Что именно проверить?' });
    const action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket } = await makeChannel({ question: () => approval, action, api: questionApi });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    expect(post.blocks.at(-1).elements.map((button: { text: { text: string } }) => button.text.text)).toEqual(['Ответить']);
    socket.receive(questionInteraction('open-multiple', post.blocks.at(-1).elements[0]));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/views.open'))).toBe(true));
    const view = JSON.parse(String(calls.find(call => call.url.endsWith('/views.open'))!.init!.body)).view;
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.blocks.filter((block: { type: string }) => block.type === 'input').map((block: { block_id: string }) => block.block_id)).toEqual(['q0-choice', 'q0-text', 'q1-text']);
    const submit = (id: string, values: unknown) => socket.receive({ envelope_id: id, type: 'interactive', payload: { type: 'view_submission',
      team: { id: 'TEXAMPLE' }, user: { id: 'UANNA' }, view: { ...view, state: { values } } } });
    submit('invalid-form', { 'q0-choice': { answer: { selected_option: { value: 'custom' } } }, 'q1-text': { answer: { value: 'read-only' } } });
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value))).toContainEqual({ envelope_id: 'invalid-form', payload: {
      response_action: 'errors', errors: { 'q0-text': 'Введите ответ длиной до 3000 символов.' },
    } }));
    expect(action).not.toHaveBeenCalled();
    socket.receive({ envelope_id: 'dismiss-form', type: 'interactive', payload: { type: 'view_closed', view: { callback_id: QUESTION_VIEW } } });
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value).envelope_id)).toContain('dismiss-form'));
    expect(approval.status).toBe('pending');
    const customText = '  Свой точный ответ 🙂\nВторая строка  ';
    submit('conflicting-form', { 'q0-choice': { answer: { selected_option: { value: '1' } } },
      'q0-text': { answer: { value: customText } }, 'q1-text': { answer: { value: 'read-only' } } });
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value))).toContainEqual({ envelope_id: 'conflicting-form', payload: {
      response_action: 'errors', errors: { 'q0-text': 'Выбран обычный вариант. Очистите поле или выберите «Свой ответ».' },
    } }));
    expect(action).not.toHaveBeenCalled();
    expect(calls.filter(call => call.url.endsWith('/views.open'))).toHaveLength(1);
    expect(calls.some(call => call.url.endsWith('/views.update'))).toBe(false);
    submit('corrected-form', { 'q0-choice': { answer: { selected_option: { value: 'custom' } } },
      'q0-text': { answer: { value: customText } }, 'q1-text': { answer: { value: 'read-only' } } });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ answers: { branch: [customText], mode: ['read-only'] } }));
    action.mockClear();
    submit('valid-form', { 'q0-choice': { answer: { selected_option: { value: '1', text: { text: 'FORGED' } } } }, 'q1-text': { answer: { value: 'read-only' } } });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ answers: { branch: ['develop'], mode: ['read-only'] } }));
  });

  it.each(['foreign-team', 'bot', 'changed-question', 'bad-index', 'unavailable'] as const)('rejects %s without native submission and gives same-workspace failures visible feedback', async failure => {
    const approval = questionApproval(), action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket } = await makeChannel({ question: () => { if (failure === 'unavailable') throw new Error('private native detail'); return approval; }, action,
      api: (method, body) => method === 'users.info' && failure === 'bot'
        ? Response.json({ ok: true, user: { id: 'UANNA', is_bot: true, profile: { display_name: 'Agent' } } }) : questionApi(method, body) });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    const event = questionInteraction('rejected-choice', post.blocks.at(-1).elements[0]);
    if (failure === 'foreign-team') event.payload.team.id = 'TOTHER';
    if (failure === 'changed-question') approval.questions![0].options![0].label = 'DIFFERENT STORED LABEL';
    if (failure === 'bad-index') event.payload.actions[0] = { ...event.payload.actions[0], action_id: 'rele_question_8', value: String(event.payload.actions[0].value).replace(/:0$/u, ':8') };
    socket.receive(event);
    await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value).envelope_id)).toContain('rejected-choice'));
    if (failure !== 'foreign-team') await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/chat.postEphemeral'))).toBe(true));
    await channel.stop();
    expect(action).not.toHaveBeenCalled();
    expect(JSON.stringify(calls.filter(call => call.url.endsWith('/chat.postEphemeral')))).not.toContain('private native detail');
  });

  it('rejects stale or actor-tampered modal metadata with visible modal feedback', async () => {
    const approval = questionApproval(), action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const question = vi.fn<NonNullable<ChannelCallbacks['question']>>().mockImplementation(context => {
      if (context.messageId !== '1000.2000') throw new Error('wrong source receipt'); return approval;
    });
    const { channel, calls, socket } = await makeChannel({ question, action, api: questionApi });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    socket.receive(questionInteraction('open-stale', post.blocks.at(-1).elements.at(-1)));
    await vi.waitFor(() => expect(calls.some(call => call.url.endsWith('/views.open'))).toBe(true));
    const view = JSON.parse(String(calls.find(call => call.url.endsWith('/views.open'))!.init!.body)).view;
    for (const [index, patch] of [{ senderId: 'UOTHER' }, { accountId: 'TOTHER:UBOT' }, { messageId: '1000.9999' }].entries()) {
      socket.receive({ envelope_id: `tampered-${index}`, type: 'interactive', payload: { type: 'view_submission', team: { id: 'TEXAMPLE' }, user: { id: 'UANNA' },
        view: { ...view, private_metadata: JSON.stringify({ ...JSON.parse(view.private_metadata), ...patch }), state: { values: { 'q0-text': { answer: { value: 'private answer' } } } } } } });
      await vi.waitFor(() => expect(socket.sent.map(value => JSON.parse(value))).toContainEqual(expect.objectContaining({ envelope_id: `tampered-${index}`, payload: expect.objectContaining({ response_action: 'update' }) })));
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps secret, oversized and subsequent question parts on the existing text-reply path without truncation', async () => {
    const { channel, calls } = await makeChannel({ question: () => questionApproval(), api: questionApi });
    const secret = questionApproval(); secret.questions![0].isSecret = true;
    const oversized = questionApproval(); oversized.questions![0].question = 'Полный вопрос '.repeat(30_000);
    const tooManyOptions = questionApproval(); tooManyOptions.questions![0].options = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index}`, description: '' }));
    const inputs = [questionDelivery(secret), { ...questionDelivery(oversized), body: oversized.questions![0].question.slice(0, 3000) },
      questionDelivery(tooManyOptions), { ...questionDelivery(questionApproval()), ordinal: 1 }];
    for (const [index, approval] of [secret, oversized, tooManyOptions, questionApproval()].entries()) await channel.deliver(inputs[index], approval);
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage')).map(call => JSON.parse(String(call.init!.body)));
    expect(posts).toHaveLength(4);
    for (const [index, post] of posts.entries()) { expect(post.blocks).toBeUndefined(); expect(post.text).toBe(inputs[index].body); }
  });

  it('ACKs a question interaction while a durable inbox write is still pending', async () => {
    const approval = questionApproval(); let release!: () => void;
    const message = vi.fn<ChannelCallbacks['message']>().mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const action = vi.fn<ChannelCallbacks['action']>().mockResolvedValue(undefined);
    const { channel, calls, socket } = await makeChannel({ question: () => approval, action, message, api: questionApi });
    await channel.deliver(questionDelivery(approval), approval);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    socket.receive(envelope('blocked-inbox'));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    socket.receive(questionInteraction('fast-choice', post.blocks.at(-1).elements[0]));
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(socket.sent.map(value => JSON.parse(value).envelope_id)).toContain('fast-choice');
    expect(socket.sent.map(value => JSON.parse(value).envelope_id)).not.toContain('blocked-inbox');
    release();
  });

  it('updates only the known question card after answer, removes controls and uses generic external closure', async () => {
    const approval = questionApproval(), input = { ...questionDelivery(approval), status: 'sent' as const, remoteMessageId: '1000.2000' };
    approval.status = 'answered';
    const { channel, calls } = await makeChannel({ api: questionApi });
    await channel.updateApproval(input, approval, { source: 'slack', senderName: 'Анна <@UPEER>', answers: { branch: ['main <@UOTHER>'] } });
    await channel.updateApproval(input, approval, { source: 'codex', senderName: 'UNPROVEN ACTOR', answers: { branch: ['UNPROVEN ANSWER'] } });
    const updates = calls.filter(call => call.url.endsWith('/chat.update')).map(call => JSON.parse(String(call.init!.body)));
    expect(updates).toHaveLength(2);
    expect(calls.some(call => call.url.endsWith('/chat.postMessage'))).toBe(false);
    expect(updates[0]).toMatchObject({ channel: 'CEXAMPLE', ts: '1000.2000', mrkdwn: false, parse: 'none', link_names: false });
    expect(updates[0].blocks.every((block: { type: string; text: { type: string } }) => block.type === 'task_card' || block.type === 'task_card' || block.type === 'section' && block.text.type === 'plain_text')).toBe(true);
    expect(updates[0].text).toContain('Ответ отправлен в Codex');
    expect(updates[0].text).toContain('С какой веткой работать?');
    expect(updates[0].text).toContain('Анна &lt;@UPEER&gt;');
    expect(updates[0].text).toContain('main &lt;@UOTHER&gt;');
    expect(updates[1].text).toContain('Вопрос закрыт в Codex');
    expect(JSON.stringify(updates[1])).not.toMatch(/UNPROVEN/);
    await channel.updateApproval(input, { ...approval, status: 'expired', decision: 'uncertain' }, { source: 'slack', senderName: 'Анна', answers: { branch: ['UNCONFIRMED ANSWER'] } });
    await channel.updateApproval(input, { ...approval, decision: 'decline' }, { source: 'rele', answers: { branch: ['DECLINED ANSWER'] } });
    const secret = { ...approval, questions: approval.questions!.map(question => ({ ...question, isSecret: true })) };
    await channel.updateApproval(input, secret, { source: 'rele', answers: { branch: ['SECRET ANSWER MUST STAY LOCAL'] } });
    const closed = calls.filter(call => call.url.endsWith('/chat.update')).slice(2).map(call => JSON.parse(String(call.init!.body)));
    expect(closed[0].text).toContain('Результат отправки ответа неизвестен. Проверьте в Codex.');
    expect(JSON.stringify(closed[0])).not.toMatch(/UNCONFIRMED ANSWER|Ответ отправлен|ответ доступен/);
    expect(closed[1].text).toContain('Вопрос отклонён');
    expect(JSON.stringify(closed[1])).not.toContain('DECLINED ANSWER');
    expect(closed[2].text).toContain('Вопрос закрыт');
    expect(JSON.stringify(closed[2])).not.toContain('SECRET ANSWER MUST STAY LOCAL');
    await expect(channel.updateApproval({ ...input, remoteMessageId: undefined }, approval)).rejects.toThrow('Некорректная карточка');
    await expect(channel.updateApproval({ ...input, origin: { ...input.origin, accountId: 'TOTHER:UBOT' } }, approval)).rejects.toThrow('Подключение Slack изменилось');
  });

  it('keeps an async answer visibly queued or uncertain until its delivery receipt and removes active controls', async () => {
    const approval = questionApproval('rele/asyncUserInput');
    expect(approval.rpcId).toBeNull();
    const input = { ...questionDelivery(approval), status: 'sent' as const, remoteMessageId: '1000.2000' };
    const { channel, calls } = await makeChannel({ api: questionApi });
    for (const decision of ['queued', 'sending', 'uncertain', 'accept']) await channel.updateApproval(input,
      { ...approval, status: 'answered', decision }, { source: 'slack', senderName: 'Анна', answers: { branch: ['main'] } });
    const updates = calls.filter(call => call.url.endsWith('/chat.update')).map(call => JSON.parse(String(call.init!.body)));
    expect(updates).toHaveLength(4);
    expect(updates[0].text).toContain('Ответ ожидает отправки в Codex');
    expect(updates[1].text).toContain('Ответ отправляется в Codex');
    expect(updates[2].text).toContain('Результат отправки ответа неизвестен');
    for (const update of updates.slice(0, 3)) expect(update.text).not.toContain('Ответ отправлен в Codex');
    expect(updates[3].text).toContain('Ответ отправлен в Codex');
    expect(updates[3].text).toContain('С какой веткой работать?\nОтвет: main');
    for (const update of updates) {
      expect(update).toMatchObject({ channel: 'CEXAMPLE', ts: '1000.2000' });
      expect(update.blocks.every((block: { type: string; text: { type: string } }) => block.type === 'task_card' || block.type === 'section' && block.text.type === 'plain_text')).toBe(true);
    }
    expect(calls.some(call => call.url.endsWith('/chat.postMessage'))).toBe(false);
  });

  it('refreshes canonical rich-text answer markers and their question without reposting or resubmitting', async () => {
    const approval = questionApproval(), messages = new Map<string, Record<string, any>[]>();
    const { channel, calls, action } = await makeChannel({ question: () => approval, api: (method, body) => {
      if (method !== 'chat.postMessage' && method !== 'chat.update') return;
      const blocks = body.blocks as Record<string, any>[];
      const ts = method === 'chat.postMessage' ? `1000.${2000 + messages.size}` : String(body.ts);
      if (method === 'chat.update' && messages.get(ts)?.some(block => block.type === 'rich_text')
        && !blocks.some(block => block.type === 'rich_text')) return Response.json({ ok: false, error: 'block_mismatch' });
      // Slack stores a posted Markdown marker as rich_text and restricts later block-type replacement.
      messages.set(ts, blocks.map(block => block.type === 'markdown' ? { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: block.text }] },
      ] } : block));
      return Response.json({ ok: true, channel: body.channel, ts });
    } });
    const prompt = questionDelivery(approval), questionTs = await channel.deliver(prompt, approval);
    const markerTs = await channel.deliver({ ...delivery(), key: `question-answer:${approval.id}`,
      body: 'Ответ получен. Проверяется отправка в Codex.' });
    expect(messages.get(markerTs)?.[0].type).toBe('rich_text');
    const input = { ...prompt, status: 'sent' as const, remoteMessageId: questionTs };
    const resolution = { source: 'slack' as const, senderName: 'Анна <@UPEER>', answers: { branch: ['main'] }, answerMarkerTs: markerTs };
    for (const decision of ['queued', 'sending', 'uncertain', 'accept', 'accept']) {
      await expect(channel.updateApproval(input, { ...approval, status: 'answered', decision }, resolution)).resolves.toBeUndefined();
      const marker = messages.get(markerTs)!;
      expect(marker).toEqual([{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: expect.any(String) }] }] }]);
      const text = marker[0].elements[0].elements[0].text;
      if (decision === 'uncertain') expect(text).not.toContain('Анна');
      else expect(text).toContain('Анна <@UPEER>');
      expect(messages.get(questionTs)?.some(block => block.type === 'actions')).toBe(false);
    }
    const updates = calls.filter(call => call.url.endsWith('/chat.update')).map(call => JSON.parse(String(call.init!.body)));
    expect(updates.map(body => body.ts)).toEqual(Array.from({ length: 5 }, () => [markerTs, questionTs]).flat());
    expect(updates.at(-2)).toMatchObject({ text: 'Ответ отправлен в Codex\nОтветил(а): Анна &lt;@UPEER&gt;',
      mrkdwn: false, parse: 'none', link_names: false });
    expect(calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(2);
    expect(messages.size).toBe(2);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('Slack native task progress', () => {
  it('temporarily relabels only a known card using its published history, then resumes normal progress', async () => {
    const fixture = progressFixture();
    const { channel, calls } = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => method === 'chat.update' ? Response.json({ ok: true, channel: body.channel, ts: body.ts }) : undefined });
    const uncertain = { statusText: 'Проверяю состояние Codex', existingOnly: true };
    await channel.updateProgress('unknown-card', fixture.origin, uncertain);
    expect(calls.some(call => /\/chat\.(postMessage|update)$/u.test(call.url))).toBe(false);
    const published = { steps: [{ id: 'step-1', text: 'Published step' }] };
    await channel.updateProgress('known-card', fixture.origin, published);
    await channel.updateProgress('known-card', fixture.origin, { ...uncertain, commentary: 'UNVERIFIED DETAIL' });
    await channel.updateProgress('known-card', fixture.origin, { steps: [...published.steps, { id: 'step-2', text: 'Recovered step' }] });
    const updates = calls.filter(call => call.url.endsWith('/chat.update')).map(call => JSON.parse(String(call.init!.body)));
    expect(calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
    expect(updates).toHaveLength(2);
    expect(updates[0].blocks[0].title).toBe(uncertain.statusText);
    expect(JSON.stringify(updates[0])).toContain('Published step');
    expect(JSON.stringify(updates[0])).not.toContain('UNVERIFIED DETAIL');
    expect(updates[1].blocks[0].title).toBe('Выполняется');
    expect(JSON.stringify(updates[1])).toContain('Published step');
    expect(JSON.stringify(updates[1])).toContain('Recovered step');
    expect(updates.every(body => body.ts === '1000.2000')).toBe(true);
  });

  it('closes only an existing known progress message with generic content', async () => {
    const fixture = progressFixture();
    const { channel, calls } = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => method === 'chat.update' ? Response.json({ ok: true, channel: body.channel, ts: body.ts }) : undefined });
    await channel.updateProgress('unknown-card', fixture.origin, { terminal: 'failed', existingOnly: true });
    expect(fixture.meta.size).toBe(0);
    expect(calls.some(call => /\/chat\.(postMessage|update)$/u.test(call.url))).toBe(false);
    await channel.updateProgress('known-card', fixture.origin, { commentary: 'Собственный публичный комментарий',
      plan: [{ step: 'Собственный шаг', status: 'in_progress' }] });
    await channel.updateProgress('known-card', fixture.origin, { terminal: 'failed', existingOnly: true });
    expect(calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
    const updates = calls.filter(call => call.url.endsWith('/chat.update'));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(String(updates[0].init!.body))).toMatchObject({ ts: '1000.2000', text: 'Ошибка выполнения',
      blocks: [{ type: 'task_card', task_id: 'known-card:progress', title: 'Ошибка выполнения', status: 'error' }] });
  });

  it('posts once, updates native grouped tasks and keeps quoted mentions inert', async () => {
    const fixture = progressFixture();
    let sawPostIntent = false;
    const { channel, calls, socket, message } = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => {
        if (method === 'chat.postMessage') sawPostIntent = [...fixture.meta.values()].some(value => JSON.parse(value).state === 'posting');
        if (method === 'chat.update') return Response.json({ ok: true, channel: body.channel, ts: body.ts });
      } });
    const progress = { commentary: 'Проверяю <@UPEER> & <!channel>', plan: [
      { step: 'Прочитать данные', status: 'completed' as const },
      { step: 'Проверить результат', status: 'in_progress' as const },
      { step: 'Подготовить ответ', status: 'pending' as const },
    ] };
    await channel.updateProgress('progress-request', fixture.origin, progress);
    await channel.updateProgress('progress-request', fixture.origin, progress);
    await channel.updateProgress('progress-request', fixture.origin, { ...progress, terminal: 'failed' });
    // A late non-terminal event must not undo the terminal state.
    await channel.updateProgress('progress-request', fixture.origin, { commentary: 'Поздний комментарий' });
    expect(sawPostIntent).toBe(true);
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage'));
    const updates = calls.filter(call => call.url.endsWith('/chat.update'));
    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    const post = JSON.parse(String(posts[0].init!.body));
    expect(post).toMatchObject({ channel: fixture.origin.chatId, thread_ts: fixture.origin.threadId,
      mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    expect(post.text).toBe('Проверяю &lt;@UPEER&gt; &amp; &lt;!channel&gt;');
    expect(post.blocks).toEqual([
      { type: 'task_card', task_id: 'progress-request:progress', title: 'Выполняется', status: 'in_progress',
        details: { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: progress.commentary }] }] } },
      { type: 'plan', title: 'План работы', tasks: [
        { task_id: 'progress-request:step:0', title: 'Прочитать данные', status: 'complete' },
        { task_id: 'progress-request:step:1', title: 'Проверить результат', status: 'in_progress' },
        { task_id: 'progress-request:step:2', title: 'Подготовить ответ', status: 'pending' },
      ] },
    ]);
    const update = JSON.parse(String(updates[0].init!.body));
    expect(update.thread_ts).toBeUndefined();
    expect(update).toMatchObject({ channel: fixture.origin.chatId, ts: '1000.2000' });
    expect(update.blocks[0]).toMatchObject({ status: 'error', title: 'Ошибка выполнения' });
    expect(update.blocks[1].tasks.map((task: { status: string }) => task.status)).toEqual(['complete', 'error', 'pending']);
    socket.receive(envelope('own-progress', 'message', { user: 'UBOT', bot_id: 'BSELF', text: post.text, blocks: post.blocks }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0].contextOnly).toBe(true);
  });

  it('recovers the known message receipt after restart and retries an update without reposting', async () => {
    const fixture = progressFixture();
    const first = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore });
    await first.channel.updateProgress('restart-progress', fixture.origin, { commentary: 'Начато' });
    await first.channel.stop();
    let attempts = 0;
    const restarted = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => {
        if (method !== 'chat.update') return;
        if (++attempts === 1) throw new Error('synthetic lost update ACK');
        return Response.json({ ok: true, channel: body.channel, ts: body.ts });
      } });
    await expect(restarted.channel.updateProgress('restart-progress', fixture.origin, { commentary: 'Готово', terminal: 'completed' })).rejects.toThrow('Соединение со Slack прервано.');
    await restarted.channel.updateProgress('restart-progress', fixture.origin, { commentary: 'Готово', terminal: 'completed' });
    expect(restarted.calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(0);
    expect(restarted.calls.filter(call => call.url.endsWith('/chat.update'))).toHaveLength(2);
    expect(JSON.parse([...fixture.meta.values()][0])).toMatchObject({ state: 'posted', ts: '1000.2000', terminal: 'completed' });
  });

  it.each(['lost-ack', 'invalid-receipt', 'interrupted-post'] as const)('does not repost after %s, including after restart', async failure => {
    const fixture = progressFixture();
    const options = { knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore };
    let release: (() => void) | undefined;
    const first = await makeChannel({ ...options, api: async method => {
      if (method !== 'chat.postMessage') return;
      if (failure === 'interrupted-post') await new Promise<void>(resolve => { release = resolve; });
      if (failure === 'invalid-receipt') return Response.json({ ok: true, channel: 'COTHER', ts: '1000.2000' });
      throw new Error('synthetic lost post ACK');
    } });
    const write = first.channel.updateProgress('uncertain-progress', fixture.origin, { commentary: 'Работаю' });
    if (failure === 'interrupted-post') await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    else await write;
    const restarted = await makeChannel(options);
    await restarted.channel.updateProgress('uncertain-progress', fixture.origin, { commentary: 'Новый комментарий', terminal: 'completed' });
    expect(restarted.calls.some(call => /\/chat\.(postMessage|update)$/u.test(call.url))).toBe(false);
    release?.();
    await write;
    expect(first.calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
  });

  it('serializes concurrent progress calls and refuses a changed or unknown source', async () => {
    const fixture = progressFixture();
    const { channel, calls } = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => method === 'chat.update' ? Response.json({ ok: true, channel: body.channel, ts: body.ts }) : undefined });
    await Promise.all([
      channel.updateProgress('concurrent-progress', fixture.origin, { commentary: 'Один' }),
      channel.updateProgress('concurrent-progress', fixture.origin, { commentary: 'Два' }),
    ]);
    const changed = { ...fixture.origin, chatId: 'COTHER' };
    changed.endpointId = endpointId('slack', changed.accountId, changed.chatId, changed.threadId);
    await channel.updateProgress('concurrent-progress', changed, { commentary: 'Другой адрес' });
    await channel.updateProgress('other-account', { ...fixture.origin, accountId: 'TOTHER:UBOT' }, { commentary: 'Другой бот' });
    await channel.updateProgress('invalid-source', { ...fixture.origin, endpointId: 'incorrect' }, { commentary: 'Неверный ID' });
    expect(calls.filter(call => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
    expect(calls.filter(call => call.url.endsWith('/chat.update'))).toHaveLength(1);
    const changedChannel = await makeChannel({ knownEndpoints: [{ ...fixture.endpoint, id: changed.endpointId, chatId: changed.chatId }], progressStore: fixture.progressStore });
    await changedChannel.channel.updateProgress('concurrent-progress', changed, { commentary: 'Тот же запрос в другом источнике' });
    expect(changedChannel.calls.some(call => /\/chat\.(postMessage|update)$/u.test(call.url))).toBe(false);
  });

  it('does not send progress without durable storage or with an oversized plan', async () => {
    const fixture = progressFixture();
    const noStore = await makeChannel({ knownEndpoints: [fixture.endpoint] });
    await noStore.channel.updateProgress('no-store', fixture.origin, { commentary: 'Не отправлять' });
    expect(noStore.calls.some(call => call.url.endsWith('/chat.postMessage'))).toBe(false);
    const durable = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore });
    await durable.channel.updateProgress('too-many', fixture.origin, { plan: Array.from({ length: 51 }, () => ({ step: 'Шаг', status: 'pending' })) });
    expect(durable.calls.some(call => call.url.endsWith('/chat.postMessage'))).toBe(false);
  });
});

describe('Slack chronological progress and separate results', () => {
  const writes = (calls: { url: string; init?: RequestInit }[]) => calls.filter(call => /\/chat\.(postMessage|update)$/u.test(call.url)).map(call => JSON.parse(String(call.init!.body)));
  const numberedApi = () => {
    let count = 0;
    return (method: string, body: Record<string, unknown>) => method === 'chat.postMessage'
      ? Response.json({ ok: true, channel: body.channel, ts: `1000.${2000 + count++}` })
      : method === 'chat.update' ? Response.json({ ok: true, channel: body.channel, ts: body.ts }) : undefined;
  };
  const click = (value: string, ts: string) => {
    const event = questionInteraction(value, { value });
    return { ...event, payload: { ...event.payload, message: { ...event.payload.message, ts } } };
  };

  it('keeps two question cycles in separate sealed blocks and posts the final below them', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    const segments: NonNullable<import('../src/server/channels/common.js').RequestProgress['segments']> = [];
    for (let index = 0; index < 3; index++) {
      if (segments.length) segments.at(-1)!.sealed = true;
      segments.push({ id: String(index), steps: [{ id: `step-${index}`, text: `Public stage ${index}` }], plan: [{ step: 'Read', status: 'in_progress' }] });
      await f.channel.updateProgress('request-example', fixture.origin, { segments });
      if (index < 2) await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: `question-${index}`, kind: 'error', body: `Question ${index}` });
    }
    fixture.meta.set('request-progress:request-example', JSON.stringify({ segments }));
    const final = { ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Separate final' };
    expect(await f.channel.deliver(final)).toBe('1000.2005');
    const posts = writes(f.calls).filter(body => body.thread_ts);
    expect(posts.map(body => body.text)).toEqual(['Public stage 0', 'Question 0', 'Public stage 1', 'Question 1', 'Public stage 2', 'Separate final']);
    expect(posts.at(-1).blocks).toEqual([{ type: 'markdown', text: 'Separate final' }]);
    const stagePosts = posts.filter(body => body.blocks?.[0]?.type === 'task_card');
    expect(new Set(stagePosts.map(body => body.blocks[0].task_id)).size).toBe(3);
    expect(new Set(stagePosts.map(body => body.blocks[1].tasks[0].task_id)).size).toBe(3);
    expect(writes(f.calls).filter(body => body.ts === '1000.2000').at(-1).blocks[0].title).toBe('Этап завершён');
    const before = writes(f.calls).length;
    segments[0].steps![0].text = 'Late altered old commentary';
    await f.channel.updateProgress('request-example', fixture.origin, { segments, terminal: 'completed' });
    expect(writes(f.calls)).toHaveLength(before);
    await f.channel.stop();
    const restarted = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    expect(await restarted.channel.deliver(final)).toBe('1000.2005');
    expect(writes(restarted.calls)).toHaveLength(0);
  });

  it('does not create empty blocks at a question or answer boundary', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore });
    await f.channel.updateProgress('request-example', fixture.origin, { segments: [], boundaries: ['question', 'answer'] });
    fixture.meta.set('request-progress:request-example', JSON.stringify({ segments: [], boundaries: ['question', 'answer'] }));
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Final only' });
    expect(writes(f.calls)).toHaveLength(1);
    expect(writes(f.calls)[0].blocks).toEqual([{ type: 'markdown', text: 'Final only' }]);
  });

  it('pages a sealed segment and its separate multipart final using their exact message receipts', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    const text = 'A'.repeat(6000) + 'B'.repeat(6000);
    const progress = { segments: [{ id: '0', sealed: true, steps: [{ id: 'long', text }] }, { id: '1', steps: [{ id: 'later', text: 'After answer' }] }] };
    fixture.meta.set('request-progress:request-example', JSON.stringify(progress));
    await f.channel.updateProgress('request-example', fixture.origin, progress);
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Result one' });
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:1', ordinal: 1, body: 'Result two' });
    f.socket.receive(click('relep:request-example:final:answer:1', '1000.2002'));
    await vi.waitFor(() => expect(writes(f.calls).at(-1).blocks[0]).toEqual({ type: 'markdown', text: 'Result two' }));
    f.socket.receive(click('relep:request-example:0:history:0', '1000.2000'));
    await vi.waitFor(() => expect(writes(f.calls).at(-1)).toMatchObject({ ts: '1000.2000' }));
    expect(writes(f.calls).at(-1).blocks[0].details.elements[0].elements.map((item: any) => item.text).join('')).toBe('A'.repeat(6000));
    const before = writes(f.calls).length;
    f.socket.receive(click('relep:request-example:1:history:0', '1000.2000'));
    f.socket.receive(click('relep:request-example:final:answer:0', '9999.9999'));
    await f.channel.stop();
    expect(writes(f.calls)).toHaveLength(before);
    expect(writes(f.calls).filter(body => body.thread_ts)).toHaveLength(3);
    expect(f.action).not.toHaveBeenCalled();
  });

  it('rejects cross-thread, cross-message and cross-team pagination', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    await f.channel.updateProgress('request-example', fixture.origin, { commentary: 'x'.repeat(7000) });
    const base = questionInteraction('forged', { value: 'relep:request-example:history:0' });
    f.socket.receive({ ...base, payload: { ...base.payload, message: { ...base.payload.message, ts: '9999.9999' } } });
    f.socket.receive({ ...base, payload: { ...base.payload, message: { ...base.payload.message, thread_ts: '9999.9999' } } });
    f.socket.receive({ ...base, payload: { ...base.payload, team: { id: 'TOTHER' } } });
    f.socket.receive(questionInteraction('out-of-range', { value: 'relep:request-example:history:99999999' }));
    await f.channel.stop(); expect(writes(f.calls)).toHaveLength(1);
  });

  it('does not blindly resend a first final with a lost ACK after restart', async () => {
    const fixture = progressFixture(), options = { knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore };
    const f = await makeChannel({ ...options, api: method => { if (method === 'chat.postMessage') throw new Error('lost ACK'); return undefined; } });
    const final = { ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Done' };
    await expect(f.channel.deliver(final)).rejects.toMatchObject({ uncertain: true });
    await f.channel.stop();
    const restarted = await makeChannel(options);
    await expect(restarted.channel.deliver(final)).rejects.toMatchObject({ uncertain: true });
    expect(writes(restarted.calls)).toHaveLength(0); expect(writes(f.calls)).toHaveLength(1);
  });

  it('uses a separately guarded final after an uncertain progress post', async () => {
    const fixture = progressFixture(); let attempt = 0;
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: method => { if (method === 'chat.postMessage' && ++attempt <= 2) throw new Error('lost ACK'); return undefined; } });
    await f.channel.updateProgress('request-example', fixture.origin, { commentary: 'Working' });
    const final = { ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Done' };
    await expect(f.channel.deliver(final)).rejects.toMatchObject({ uncertain: true });
    await expect(f.channel.deliver(final)).rejects.toMatchObject({ uncertain: true });
    expect(writes(f.calls)).toHaveLength(2);
  });

  it('retries a lost final page update ACK on its known message', async () => {
    const fixture = progressFixture(); let fail = true; const api = numberedApi();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore,
      api: (method, body) => { if (method === 'chat.update' && fail) { fail = false; throw new Error('lost update ACK'); } return api(method, body); } });
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'First' });
    const second = { ...delivery(), origin: fixture.origin, key: 'answer:1', ordinal: 1, body: 'Second' };
    await expect(f.channel.deliver(second)).rejects.toMatchObject({ retryable: true, uncertain: false });
    expect(await f.channel.deliver(second)).toBe('1000.2000');
    expect(writes(f.calls).filter(body => body.thread_ts)).toHaveLength(1);
    expect(writes(f.calls).filter(body => body.ts)).toHaveLength(2);
  });

  it('recognizes an already delivered legacy combined final without republishing it', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    await f.channel.updateProgress('request-example', fixture.origin, { commentary: 'Legacy work' });
    const [key, raw] = [...fixture.meta.entries()][0];
    fixture.meta.set(key, JSON.stringify({ ...JSON.parse(raw), terminal: 'completed', answers: [{ key: 'answer:0', ordinal: 0, text: 'Legacy final' }] }));
    expect(await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Legacy final' })).toBe('1000.2000');
    expect(writes(f.calls)).toHaveLength(1);
  });

  it.each(['route', 'timestamp'])('refuses a mismatched legacy final %s without posting', async field => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    await f.channel.updateProgress('request-example', fixture.origin, { commentary: 'Legacy' });
    const [key, raw] = [...fixture.meta.entries()][0];
    fixture.meta.set(key, JSON.stringify({ ...JSON.parse(raw), ...(field === 'route' ? { route: 'wrong-source' } : { ts: 'not-a-slack-ts' }),
      answers: [{ key: 'answer:0', ordinal: 0, text: 'Legacy final' }] }));
    await expect(f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'answer:0', body: 'Legacy final' })).rejects.toThrow();
    expect(writes(f.calls)).toHaveLength(1);
  });

  it('clears mixed-client details and sends its generic closure separately', async () => {
    const fixture = progressFixture();
    const f = await makeChannel({ knownEndpoints: [fixture.endpoint], progressStore: fixture.progressStore, api: numberedApi() });
    const progress = { commentary: 'Own progress' };
    fixture.meta.set('request-progress:request-example', JSON.stringify(progress));
    await f.channel.updateProgress('request-example', fixture.origin, progress);
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'retry:1', body: 'Retry in 15 s' });
    expect(writes(f.calls).at(-1).blocks[0].title).toBe('Retry in 15 s');
    await f.channel.updateProgress('request-example', fixture.origin, { terminal: 'failed', existingOnly: true });
    expect(writes(f.calls).at(-1).blocks[0].details).toBeUndefined();
    await f.channel.deliver({ ...delivery(), origin: fixture.origin, key: 'terminal:error', kind: 'error', body: 'Generic closure' });
    expect(writes(f.calls).at(-1).blocks).toEqual([{ type: 'markdown', text: 'Generic closure' }]);
    expect(writes(f.calls).filter(body => body.thread_ts)).toHaveLength(2);
  });
});

describe('Slack Socket Mode durability and identity', () => {
  it('ACKs only after the durable message callback completes', async () => {
    let commit!: () => void;
    const durable = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const message = vi
      .fn<ChannelCallbacks['message']>()
      .mockImplementation(() => durable);
    const { socket } = await makeChannel({ message });
    socket.receive(envelope('env-1'));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
    commit();
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]),
    );
  });

  it('does not ACK a failed inbox write and can accept a later replay', async () => {
    const message = vi
      .fn<ChannelCallbacks['message']>()
      .mockRejectedValueOnce(new Error('Synthetic disk error'))
      .mockResolvedValue(undefined);
    const { socket, channel } = await makeChannel({ message });
    socket.receive(envelope('env-failed'));
    await vi.waitFor(() =>
      expect(channel.state.error).toContain('Не удалось сохранить событие'),
    );
    expect(socket.sent).toEqual([]);
    socket.receive(envelope('env-replay'));
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([
        JSON.stringify({ envelope_id: 'env-replay' }),
      ]),
    );
  });

  it('delivers native Stop as a durable control, without fabricating a Slack transcript message', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UANNA', name: 'Anna' }], updatedAt: '2026-10-20T00:00:00Z' };
    let commit!: () => void;
    const persisted = new Promise<void>(resolve => { commit = resolve; });
    const message = vi.fn<ChannelCallbacks['message']>().mockRejectedValueOnce(new Error('Synthetic disk error')).mockImplementationOnce(() => persisted);
    const { socket, channel } = await makeChannel({ message, knownEndpoints: [known] });
    const stop = envelope('native-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', streaming_message_ts: [] });
    socket.receive(stop);
    await vi.waitFor(() => expect(channel.state.error).toContain('Не удалось сохранить событие'));
    expect(socket.sent).toEqual([]);
    socket.receive(stop);
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    expect(message.mock.calls[1][0]).toEqual({ control: 'stop', eventId: 'agent-session-stopped:outer-native-stop', endpoint: known, sender: { id: 'UANNA', name: 'Анна (пример)', isBot: false }, messageId: '1000.2000', text: '' });
    expect(socket.sent).toEqual([]);
    commit();
    await vi.waitFor(() => expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'native-stop' })]));
  });

  it('rejects foreign and malformed native Stop events before the control callback', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [], updatedAt: '2026-10-20T00:00:00Z' };
    const { socket, message } = await makeChannel({ knownEndpoints: [known] });
    const stop = envelope('foreign-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', streaming_message_ts: [] });
    socket.receive({ ...stop, payload: { ...stop.payload, team_id: 'TOTHER' } });
    for (const patch of [{ channel: 'COTHER' }, { thread_ts: '1000.9999' }, { thread_ts: undefined }, { user: 'invalid' }, { event_ts: undefined }]) {
      socket.receive(envelope('invalid-stop', 'message', { type: 'agent_session_stopped', event_ts: '1000.2000', ...patch }));
    }
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect(message).not.toHaveBeenCalled();
  });

  it('normalizes app_mention and message to the same dedupe identity and named endpoint', async () => {
    const received: InboundMessage[] = [];
    const { socket, endpoints } = await makeChannel({
      message: async (value) => {
        received.push(value);
      },
    });
    socket.receive(envelope('env-message', 'message'));
    socket.receive(envelope('env-mention', 'app_mention'));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0].eventId).toBe(received[1].eventId);
    expect(received[0].endpoint.id).toBe(received[1].endpoint.id);
    expect(received[0].endpoint.accountId).toBe('TEXAMPLE:UBOT');
    expect(received[0].text).toBe('<@UBOT> Пример сообщения');
    await vi.waitFor(() => expect(endpoints).toHaveBeenCalled());
    const named = endpoints.mock.calls.at(-1)![0];
    expect(named.title).toBe('Пример сообщения');
    expect(named.subtitle).toBe('Пример команды · #example');
    expect(named.people).toContainEqual({ id: 'UANNA', name: 'Анна (пример)', isBot: false });
  });

  it('persists self and peer bot messages while rejecting another workspace', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('env-self', 'message', { user: 'UBOT' }));
    socket.receive(envelope('env-bot', 'message', { bot_id: 'BOTHER' }));
    const foreign = envelope('env-foreign');
    foreign.payload.team_id = 'TOTHER';
    socket.receive(foreign);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(message).toHaveBeenCalledTimes(2);
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ contextOnly: true, sender: { id: 'UBOT', isBot: true } });
    expect(vi.mocked(message).mock.calls[1][0]).toMatchObject({ contextOnly: false, directMention: true, sender: { id: 'UANNA', isBot: true } });
  });

  it('reports fresh peer mentions for the binding policy and never wakes itself', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('peer-passive', 'message', { user: 'UPEER', bot_id: 'BPEER', text: 'Готово', ts: '1000.1002' }));
    socket.receive(envelope('peer-block', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '', blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_quote', elements: [{ type: 'user', user_id: 'UBOT' }] }] }], ts: '1000.1003' }));
    socket.receive(envelope('peer-direct', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '<@UBOT> Проверь', ts: '1000.1004' }));
    socket.receive(envelope('self-direct', 'message', { user: 'UBOT', text: '<@UBOT> Мой ответ', ts: '1000.1005' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(4));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received.map(value => value.contextOnly)).toEqual([false, true, false, true]);
    expect(received.map(value => value.directMention)).toEqual([false, false, true, true]);
    expect(received[0].endpoint.people).toContainEqual({ id: 'UPEER', name: 'Бот Slack', isBot: true });
    expect(received[3].endpoint.people.some(person => person.id === 'UBOT')).toBe(false);
  });

  it('keeps complete visible payload and distinct edit/delete receipts from inner source identity', async () => {
    const { socket, message } = await makeChannel();
    const long = 'я'.repeat(60_000);
    const original = { type: 'message', user: 'UANNA', ts: '1000.1001', thread_ts: '1000.1000', text: long, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: long } }], files: [{ id: 'FONE', name: 'Отчёт.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/one', token: 'synthetic-exclude' }], attachments: [{ text: 'Приложение' }], bot_profile: { name: 'noise' }, reply_count: 7 };
    socket.receive(envelope('full-original', 'message', original));
    socket.receive(envelope('full-edit', 'message', { subtype: 'message_changed', ts: '9999.1', thread_ts: '9999.0', message: { ...original, text: long + ' изменено', edited: { user: 'UANNA', ts: '1001.1' } } }));
    socket.receive(envelope('full-delete', 'message', { subtype: 'message_deleted', ts: '9999.2', deleted_ts: '1000.1001', previous_message: original }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(3));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received.every(value => value.endpoint.threadId === '1000.1000' && value.messageId === '1000.1001')).toBe(true);
    expect(new Set(received.map(value => value.eventId)).size).toBe(3);
    expect(received.map(value => value.slack?.kind)).toEqual(['message', 'edit', 'deleted']);
    expect(received.map(value => value.contextOnly)).toEqual([false, true, true]);
    expect(received[0].text).toHaveLength(60_000);
    expect(received[0].slack?.payload).toMatchObject({ text: long, blocks: original.blocks, attachments: original.attachments, files: [{ id: 'FONE', name: 'Отчёт.pdf', mimetype: 'application/pdf' }] });
    expect(JSON.stringify(received[0].slack?.payload)).not.toMatch(/synthetic-exclude|bot_profile|reply_count|event_ts/);
  });

  it.each(['> <@UBOT> цитата', '`<@UBOT>`', '``<@UBOT>``', '``a ` <@UBOT> b``', '```md\n<@UBOT>\n```', '~~~\n<@UBOT>\n~~~'])('does not treat a quoted/code-only token as a fresh peer mention: %s', async text => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('quoted-peer', 'message', { user: 'UPEER', bot_id: 'BPEER', text }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ directMention: false, contextOnly: false });
  });

  it('recognizes remembered bot roles without persisting an app event as the account identity', async () => {
    const known: Endpoint = { id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', '1000.1000'), platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId: '1000.1000', title: 'Thread', subtitle: 'Slack', people: [{ id: 'UPEER', name: 'Другой агент', isBot: true }], updatedAt: '2026-10-20T00:00:00Z' };
    const { socket, message } = await makeChannel({ knownEndpoints: [known] });
    socket.receive(envelope('remembered-peer', 'message', { user: 'UPEER', text: 'Сводка' }));
    socket.receive(envelope('app-peer', 'message', { user: 'UAPP', app_id: 'AOTHER', text: 'Сводка', ts: '1000.1002' }));
    socket.receive(envelope('remember-app-role', 'message', { user: 'UAPP', text: 'Сводка в другом треде', ts: '1000.1003', thread_ts: '1000.0999' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(3));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    for (const value of received) expect(value).toMatchObject({ directMention: false, contextOnly: false });
    expect(received.map(value => value.sender.isBot)).toEqual([true, true, undefined]);
  });

  it('persists unknown message subtypes as context without making them task candidates', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('system-context', 'message', { subtype: 'assistant_app_thread', text: '<@UBOT> Context' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ contextOnly: true, slack: { payload: { subtype: 'assistant_app_thread' } } });
  });

  it('persists block-only/file-only app posts without adding fake authors to selectable people', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('block-only', 'message', { user: undefined, bot_id: 'BHOOK', subtype: 'bot_message', text: '', blocks: [{ type: 'section', text: { type: 'plain_text', text: 'CI завершён' } }] }));
    socket.receive(envelope('file-only', 'message', { user: undefined, text: '', subtype: 'file_share', ts: '1000.1002', files: [{ id: 'FONE', title: 'Схема', mimetype: 'image/png' }] }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received[0]).toMatchObject({ sender: { id: 'bot:BHOOK', isBot: true }, text: 'CI завершён', contextOnly: false });
    expect(received[1]).toMatchObject({ sender: { id: 'slack:unknown' }, text: '', contextOnly: true, slack: { payload: { files: [{ title: 'Схема' }] } } });
    expect(received.every(value => value.endpoint.people.length === 0)).toBe(true);
  });

  it('admits bot_id-only agents in an open group, while preserving selected-sender and own-bot guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rele-slack-bot-only-')); files.push(dir);
    const store = new Store(join(dir, 'test.sqlite'));
    const source = (threadId: string): Endpoint => ({ id: endpointId('slack', 'TEXAMPLE:UBOT', 'CEXAMPLE', threadId),
      platform: 'slack', accountId: 'TEXAMPLE:UBOT', chatId: 'CEXAMPLE', threadId, title: 'Thread', subtitle: 'Slack', people: [], updatedAt: new Date().toISOString() });
    const open = source('1000.1000'), selected = source('1000.2000');
    store.upsertEndpoint(open); store.upsertEndpoint(selected);
    const conversation = store.createConversation({ name: 'Codex', threadId: 'codex-thread', cwd: '/project',
      bindings: [{ platform: 'slack', endpointId: open.id, allowedSenderIds: [] }, { platform: 'slack', endpointId: selected.id, allowedSenderIds: ['UHUMAN'] }] });
    store.setSourceAccess(open.id, { mode: 'all' });
    const received: InboundMessage[] = [];
    try {
      const { socket } = await makeChannel({ knownEndpoints: [open, selected], message: async value => { received.push(value); store.ingest(value); } });
      socket.receive(envelope('bot-only-open', 'message', { user: undefined, bot_id: 'BPEER', username: 'Peer agent', subtype: 'bot_message', text: 'Unmentioned work', ts: '1000.1001' }));
      socket.receive(envelope('bot-only-selected', 'message', { user: undefined, bot_id: 'BPEER', username: 'Peer agent', text: '<@UBOT> Work', thread_ts: selected.threadId, ts: '1000.2001' }));
      socket.receive(envelope('bot-only-self', 'message', { user: undefined, bot_id: 'BSELF', username: 'Peer agent', text: '<@UBOT> Echo', ts: '1000.1002' }));
      socket.receive(envelope('bot-only-invalid', 'message', { user: undefined, bot_id: 'invalid:BPEER', username: 'Peer agent', text: '<@UBOT> Work', ts: '1000.1003' }));
      await vi.waitFor(() => expect(received).toHaveLength(4));
      expect(received[0]).toMatchObject({ contextOnly: false, directMention: false, sender: { id: 'bot:BPEER', name: 'Peer agent', isBot: true } });
      expect(received[2]).toMatchObject({ contextOnly: true, sender: { id: 'bot:BSELF', isBot: true } });
      expect(received[3]).toMatchObject({ contextOnly: true, sender: { id: 'slack:unknown' } });
      expect(store.listRequests()).toEqual([expect.objectContaining({ origin: expect.objectContaining({ endpointId: open.id, senderId: 'bot:BPEER', senderIsBot: true }) })]);
      const binding = store.getConversation(conversation.id)!.bindings.find(value => value.endpointId === selected.id)!;
      store.updateBinding(conversation.id, binding.id, selected.id, ['bot:BPEER']);
      socket.receive(envelope('bot-only-chosen', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Explicitly selected work', thread_ts: selected.threadId, ts: '1000.2002' }));
      await vi.waitFor(() => expect(store.listRequests()).toHaveLength(2));
      store.setSourceAccess(open.id, { mode: 'mention' });
      socket.receive(envelope('bot-only-unmentioned', 'message', { user: undefined, bot_id: 'BPEER', text: 'No mention', ts: '1000.1004' }));
      socket.receive(envelope('bot-only-mentioned', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Mentioned', ts: '1000.1005' }));
      await vi.waitFor(() => expect(received).toHaveLength(7));
      expect(store.listRequests()).toHaveLength(3);
      expect(store.listRequests()[0].text).toBe('<@UBOT> Mentioned');
    } finally { store.close(); }
  });

  it('keeps bot-only posts passive if Slack did not provide the connected bot identity', async () => {
    const { socket, message } = await makeChannel({ api: method => method === 'auth.test'
      ? Response.json({ ok: true, team_id: 'TEXAMPLE', user_id: 'UBOT', team: 'Team' }) : undefined });
    socket.receive(envelope('bot-unresolved-owner', 'message', { user: undefined, bot_id: 'BPEER', text: '<@UBOT> Work' }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ sender: { id: 'bot:BPEER', isBot: true }, contextOnly: true });
  });

  it('sends only verified tool mentions in a separate mrkdwn section and keeps the body rich', async () => {
    const { channel, calls } = await makeChannel();
    const tool: Delivery = { ...delivery(), kind: 'message', requestId: undefined, operationId: 'operation',
      body: '**Result** <@UUNVALIDATED> @everyone', mentions: [{ id: 'UPEER', name: 'Untrusted caption', isBot: true }],
      origin: { ...delivery().origin, senderId: 'UBOT', senderName: 'Own agent', messageId: '' } };
    await channel.deliver(tool);
    const post = JSON.parse(String(calls.find(call => call.url.endsWith('/chat.postMessage'))!.init!.body));
    expect(post.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '<@UPEER>', verbatim: true } },
      { type: 'markdown', text: '**Result** @\u200bUUNVALIDATED @\u200beveryone' },
    ]);
    expect(post.text).not.toContain('<@UPEER>');
    expect(post.link_names).toBe(false);
    expect(channel.deliveryText(tool)).toBe('<@UPEER>\n\n**Result** @\u200bUUNVALIDATED @\u200beveryone');
    await expect(channel.deliver({ ...tool, mentions: [{ id: 'bot:BPEER', name: 'Agent', isBot: true }] })).rejects.toThrow(/адрес упоминания/);
    await channel.deliver({ ...tool, mentions: [] });
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage'));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1].init!.body)).blocks).toEqual([{ type: 'markdown', text: '**Result** @\u200bUUNVALIDATED @\u200beveryone' }]);
  });

  it('keeps non-audio uploads as context while allowing a human voice task', async () => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('human-file', 'message', { text: '', subtype: 'file_share', files: [{ id: 'FPDF', name: 'Отчёт.pdf', mimetype: 'application/pdf' }] }));
    socket.receive(envelope('human-voice', 'message', { text: '', subtype: 'file_share', ts: '1000.1002', files: [{ id: 'FAUDIO', name: 'Сообщение.ogg', mimetype: 'audio/ogg', url_private_download: 'https://files.slack.com/files-pri/audio.ogg' }] }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledTimes(2));
    const received = vi.mocked(message).mock.calls.map(([value]) => value);
    expect(received[0]).toMatchObject({ contextOnly: true, text: '', slack: { payload: { files: [{ id: 'FPDF' }] } } });
    expect(received[0].audio).toBeUndefined();
    expect(received[1]).toMatchObject({ contextOnly: false, audio: { fileId: 'FAUDIO', mimeType: 'audio/ogg' } });
  });

  it.each([
    { name: 'native user', mention: true, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'native quote', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_quote', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'preformatted', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'code style', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT', style: { code: true } }, { type: 'text', text: ' Проверь' }] }] }] },
    { name: 'markdown', mention: true, blocks: [{ type: 'markdown', text: '<@UBOT> Проверь' }] },
    { name: 'mrkdwn', mention: true, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<@UBOT> Проверь' } }] },
    { name: 'quoted mrkdwn', mention: false, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '> <@UBOT> Проверь' } }] },
    { name: 'inline code', mention: false, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '`<@UBOT>` Проверь' } }] },
    { name: 'forwarded metadata', mention: false, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Проверь' }] }], forwarded: { type: 'user', user_id: 'UBOT' } }] },
    { name: 'attachment', mention: false, attachments: [{ blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UBOT' }, { type: 'text', text: ' Проверь' }] }] }] }] },
  ])('only accepts fresh rendered current-block mentions: $name', async ({ mention, ...payload }) => {
    const { socket, message } = await makeChannel();
    socket.receive(envelope('peer-native', 'message', { user: 'UPEER', bot_id: 'BPEER', text: '', ...payload }));
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    expect(vi.mocked(message).mock.calls[0][0]).toMatchObject({ directMention: mention, contextOnly: false });
  });
});

describe('Slack origin-bound delivery', () => {
  it('sends into the original thread and disables mentions, parsing and unfurls', async () => {
    const { channel, calls } = await makeChannel();
    await expect(channel.deliver(delivery())).resolves.toBe('1000.2000');
    const sent = calls.find((call) => call.url.endsWith('/chat.postMessage'))!;
    expect(JSON.parse(String(sent.init?.body))).toMatchObject({
      channel: 'CEXAMPLE',
      thread_ts: '1000.1000',
      text: 'Пример @\u200beveryone &amp; ответ',
      blocks: [{ type: 'markdown', text: 'Пример @\u200beveryone & ответ' }],
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('preserves Markdown tables and citations only for answer deliveries', async () => {
    const { channel, calls } = await makeChannel();
    const text = '| Файл |\n| --- |\n| Пример |\n:codex-file-citation{path="C:/Отчёт.md" purpose="source"}';
    await channel.deliver({ ...delivery(), body: text });
    await channel.deliver({ ...delivery(), kind: 'error', body: text });
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage')).map(call => JSON.parse(String(call.init?.body)));
    expect(posts[0].blocks).toEqual([{ type: 'markdown', text: text.replace(':codex-file-citation{path="C:/Отчёт.md" purpose="source"}', '`C:/Отчёт.md`') }]);
    expect(posts[1].blocks).toBeUndefined();
    expect(posts[1].text).toBe(text);
  });

  it.each([
    ['long text and mentions', `${'a'.repeat(2898)}<@UPEER> @everyone\n${'b'.repeat(350)}`],
    ['emoji and mentions', `Сообщение:\n${'🙂'.repeat(3000)} <@UPEER> & @everyone — конец`],
  ])('preserves the entire approval preview in bounded plain-text sections: %s', async (_name, body) => {
    const { channel, calls } = await makeChannel();
    const approval: Approval = { id: 'approval-example', requestId: 'request-example', turnId: 'turn-example',
      itemId: 'mcp-example', rpcId: 'rpc-example', method: 'mcpServer/elicitation/request', title: 'Разрешить сообщение',
      details: body, status: 'pending', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
    await channel.deliver({ ...delivery(), kind: 'approval', approvalId: approval.id, body }, approval);
    const posts = calls.filter(call => call.url.endsWith('/chat.postMessage'));
    expect(posts).toHaveLength(1);
    const post = JSON.parse(String(posts[0].init?.body));
    const sections = post.blocks.filter((block: { type: string }) => block.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.map((block: { text: { text: string } }) => block.text.text).join('')).toBe(body);
    for (const section of sections) {
      expect(section.text.type).toBe('plain_text');
      expect(section.text.text.length).toBeLessThanOrEqual(2900);
      expect(section.text.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
    expect(post).toMatchObject({ channel: 'CEXAMPLE', thread_ts: '1000.1000', mrkdwn: false, parse: 'none', link_names: false });
    expect(post.blocks.at(-1)).toEqual({ type: 'actions', elements: ['accept', 'decline'].map(decision => ({
      type: 'button', action_id: `rele_${decision}`, text: { type: 'plain_text', text: decision === 'accept' ? 'Разрешить' : 'Отклонить' },
      value: `rele:${approval.id}:${decision}`,
    })) });
  });

  it('sets and clears only the original account/thread status without a status callback loop', async () => {
    const { channel, calls, status } = await makeChannel({ api: method => method === 'agents.sessions.setStatus' ? Response.json({ ok: true }) : undefined });
    const before = status.mock.calls.length;
    await channel.setThreadStatus(delivery().origin, 'processing');
    await channel.setThreadStatus(delivery().origin, 'active');
    const updates = calls.filter(call => call.url.endsWith('/agents.sessions.setStatus'));
    expect(updates.map(call => JSON.parse(String(call.init?.body)))).toEqual([{ channel_id: 'CEXAMPLE', thread_ts: '1000.1000', status: 'processing' }, { channel_id: 'CEXAMPLE', thread_ts: '1000.1000', status: 'active' }]);
    expect(updates.every(call => new Headers(call.init?.headers).get('content-type')?.startsWith('application/json'))).toBe(true);
    expect(status).toHaveBeenCalledTimes(before);
    await expect(channel.setThreadStatus(delivery('TOTHER:UBOT').origin, 'processing')).rejects.toThrow('Подключение Slack изменилось');
    expect(calls.filter(call => call.url.endsWith('/agents.sessions.setStatus'))).toHaveLength(2);
  });

  it('propagates a native status failure to its manager', async () => {
    const { channel } = await makeChannel({ api: method => method === 'agents.sessions.setStatus' ? Response.json({ ok: false, error: 'missing_scope' }) : undefined });
    await expect(channel.setThreadStatus(delivery().origin, 'processing')).rejects.toMatchObject({ retryable: false, uncertain: false });
  });

  it('reports a missing native Stop subscription once and clears it when fixed', async () => {
    let subscribed = false;
    const { channel, status } = await makeChannel({ api: method => method === 'agents.sessions.setStatus'
      ? Response.json({ ok: true, response_metadata: { warnings: subscribed ? [] : ['missing_agent_session_stopped_event_subscription'] } }) : undefined });
    const before = status.mock.calls.length;
    await channel.setThreadStatus(delivery().origin, 'processing');
    expect(channel.state.error).toContain('agent_session_stopped');
    await channel.setThreadStatus(delivery().origin, 'processing');
    expect(status).toHaveBeenCalledTimes(before + 1);
    subscribed = true;
    await channel.setThreadStatus(delivery().origin, 'active');
    expect(channel.state.error).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(before + 2);
  });

  it('never sends a request through a different installation/account', async () => {
    const { channel, calls } = await makeChannel();
    await expect(
      channel.deliver(delivery('TOTHER:UOTHER')),
    ).rejects.toMatchObject({ retryable: false, uncertain: false });
    expect(calls.some((call) => call.url.endsWith('/chat.postMessage'))).toBe(
      false,
    );
  });

  it('classifies a lost send acknowledgement as uncertain, not an automatic retry', async () => {
    const { channel } = await makeChannel({
      postMessage: async () => {
        throw new TypeError('Synthetic connection reset');
      },
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: false,
      uncertain: true,
    });
  });

  it('accepts an explicit 429 as safe to retry and respects Retry-After', async () => {
    const { channel } = await makeChannel({
      postMessage: async () =>
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: true,
      uncertain: false,
      retryAfterMs: 7000,
    });
  });

  it('does not trust a successful response for a different destination', async () => {
    const { channel } = await makeChannel({
      postMessage: async () =>
        Response.json({ ok: true, ts: '1000.2000', channel: 'COTHER' }),
    });
    await expect(channel.deliver(delivery())).rejects.toMatchObject({
      retryable: false,
      uncertain: true,
    });
  });
});

describe('Slack private audio URL restrictions', () => {
  it.each([
    'http://files.slack.com/files-pri/example',
    'https://files.slack.com.evil.invalid/files-pri/example',
    'https://127.0.0.1/files-pri/example',
    'https://files.slack.com/files-pri/T00000000-F00000000/fixture-1984453',
    'https://files.slack.com/files-pri/T00000000-F00000000/fixture-9889589',
    'https://files.slack.com:8443/files-pri/example',
  ])('rejects unsafe URL before attaching a bot token: %s', async (url) => {
    const { channel, calls } = await makeChannel();
    const before = calls.length;
    await expect(
      channel.download(
        { platform: 'slack', name: 'example.ogg', url },
        '/tmp/unused-rele-audio-test',
      ),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(calls).toHaveLength(before);
  });

  it('downloads only an allowed private file and forbids credential-bearing redirects', async () => {
    const { channel, calls } = await makeChannel();
    const directory = await mkdtemp(join(tmpdir(), 'rele-slack-test-'));
    files.push(directory);
    const file = join(directory, 'audio.ogg');
    await channel.download(
      {
        platform: 'slack',
        name: 'example.ogg',
        url: 'https://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/example.ogg',
        size: 3,
      },
      file,
    );
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
    const request = calls.at(-1)!;
    expect(request.init).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer SLACK_TOKEN_PLACEHOLDER_4051722' },
    });
  });
});

#!/usr/bin/env python3
"""Real Rele managed adapter + engine, two Codex processes, isolated fake provider.

This tests persisted shared history and process ownership, not the Desktop GUI.
No user profile, credentials, real model, or messenger is used.
"""
import argparse
import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import uuid
from aiohttp import web
import websockets

parser = argparse.ArgumentParser(description=__doc__)
source = parser.add_mutually_exclusive_group(required=True)
source.add_argument('--codex-prefix')
source.add_argument('--codex', help='Native executable inside a complete extracted Codex package.')
parser.add_argument('--expected-version', required=True, choices=['0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11', '0.163.0-alpha.11.2', '0.164.0-alpha.11.1', '0.165.0-alpha.1.2', '0.166.0-alpha.5.1', '0.166.0-alpha.6'])
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
binary = 'codex.exe' if os.name == 'nt' else 'codex'
if args.codex:
    CLI = str(Path(args.codex).resolve(strict=True))
else:
    candidates = list(Path(args.codex_prefix).glob(f'node_modules/@openai/codex-*/vendor/*/bin/{binary}'))
    if len(candidates) != 1:
        parser.error('Expected one native binary in the isolated npm prefix.')
    CLI = str(candidates[0].resolve())
REPO = Path(__file__).resolve().parent.parent
PROCESS_HOST = REPO / 'dist' / 'native' / 'Rele.Process.exe'
if os.name == 'nt' and not PROCESS_HOST.is_file():
    parser.error('Build the Windows process host with npm run prebuild before the managed probe.')


class Rpc:
    def __init__(self, ws):
        self.ws, self.pending, self.events = ws, {}, []
        self.task = asyncio.create_task(self.pump())

    async def pump(self):
        async for raw in self.ws:
            obj = json.loads(raw)
            if 'method' not in obj and obj.get('id') in self.pending:
                future = self.pending.pop(obj['id'])
                if not future.done():
                    future.set_result(obj)
            else:
                self.events.append(obj)

    async def call(self, method, params):
        rid = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        await self.ws.send(json.dumps({'id': rid, 'method': method, 'params': params}))
        response = await asyncio.wait_for(future, 25)
        assert 'result' in response, response
        return response['result']

    async def completed(self, turn_id):
        async def poll():
            while not any(e.get('method') == 'turn/completed' and e['params']['turn']['id'] == turn_id for e in self.events):
                await asyncio.sleep(.02)
        await asyncio.wait_for(poll(), 25)

    async def close(self):
        await self.ws.close()
        with contextlib.suppress(Exception):
            await self.task


def frame(event):
    return ('data: ' + json.dumps(event) + '\n\n').encode()


async def main(root):
    report = {'codexVersion': args.expected_version, 'platform': os.name, 'actualDesktopTested': False,
              'realModelRequests': 0, 'realMessengerRequests': 0, 'checks': {}}
    records, servers, errors = [], [], []
    bridge = None
    bridge_drain = None

    async def provider(req):
        if req.method != 'POST' or not req.path.endswith('/responses'):
            return web.json_response({'data': []})
        body = await req.json()
        records.append(body)
        index = len(records)
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(req)
        await response.write(frame({'type': 'response.created', 'response': {'id': f'resp-{index}'}}))
        item = {'type': 'message', 'role': 'assistant', 'id': f'msg-{index}', 'phase': 'final_answer',
                'content': [{'type': 'output_text', 'text': f'managed-answer-{index}'}]}
        await response.write(frame({'type': 'response.output_item.done', 'output_index': 0, 'item': item}))
        await response.write(frame({'type': 'response.completed', 'response': {'id': f'resp-{index}',
                                    'usage': {'input_tokens': 10, 'output_tokens': 3, 'total_tokens': 13}}}))
        await response.write_eof()
        return response

    app = web.Application()
    app.router.add_route('*', '/{tail:.*}', provider)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    provider_port = site._server.sockets[0].getsockname()[1]
    home = root / 'c'
    workspace = root / 'work'
    home.mkdir()
    workspace.mkdir()
    config = f'''model="mock-model"
model_provider="mock_provider"
approval_policy="never"
sandbox_mode="read-only"
cli_auth_credentials_store="file"
[features]
plugins=false
[model_providers.mock_provider]
name="Rele isolated managed fixture"
base_url="http://127.0.0.1:{provider_port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
stream_max_retries=0
'''
    (home / 'config.toml').write_text(config, encoding='utf-8')
    env = {k: v for k, v in os.environ.items() if k.upper() in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT')}
    env.update({'CODEX_HOME': str(home), 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'})

    async def drain(process):
        while line := await process.stderr.readline():
            errors.append(line.decode(errors='replace').strip())
            if len(errors) > 40:
                errors.pop(0)

    async def start_source(name):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        command = [CLI, 'app-server', '--listen', f'ws://127.0.0.1:{port}']
        if os.name == 'nt':
            command = [str(PROCESS_HOST), '--', *command]
        process = await asyncio.create_subprocess_exec(*command,
            cwd=workspace, env=env, stdin=asyncio.subprocess.PIPE if os.name == 'nt' else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        entry = {'process': process, 'drain': asyncio.create_task(drain(process)), 'client': None}
        servers.append(entry)
        for _ in range(160):
            try:
                ws = await websockets.connect(f'ws://127.0.0.1:{port}', proxy=None, open_timeout=1, max_size=2**25)
                break
            except (OSError, TimeoutError):
                if process.returncode is not None:
                    raise RuntimeError(errors)
                await asyncio.sleep(.05)
        else:
            raise RuntimeError('Source did not listen')
        client = Rpc(ws)
        entry['client'] = client
        runtime = await client.call('initialize', {'clientInfo': {'name': name, 'version': '0.0.0'}, 'capabilities': {'experimentalApi': True}})
        await ws.send(json.dumps({'method': 'initialized'}))
        assert f'/{args.expected_version} ' in runtime['userAgent'], runtime
        entry['runtimePid'] = (await client.call('server/diagnostics', {}))['process']['id']
        return entry

    async def stop_source(entry):
        if entry['client']:
            await entry['client'].close()
            entry['client'] = None
        process = entry['process']
        if process.returncode is None:
            if os.name == 'nt':
                # The host owns every native Codex descendant from creation.
                # EOF requests job termination; zero exit confirms the empty job.
                process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), 20)
                except TimeoutError:
                    # Releasing the host's private job handle also terminates its
                    # descendants, but a deadline is never a successful cleanup.
                    process.kill()
                    await process.wait()
                    raise
            else:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 8)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        if os.name == 'nt' and process.returncode != 0:
            raise RuntimeError(f'Isolated source job shutdown failed: host exit {process.returncode}')
        await asyncio.wait_for(asyncio.shield(entry['drain']), 8)

    async def source_turn(entry, thread, text):
        result = await entry['client'].call('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': text}]})
        await entry['client'].completed(result['turn']['id'])

    async def bridge_read():
        line = await asyncio.wait_for(bridge.stdout.readline(), 55)
        if not line:
            raise RuntimeError('Rele fixture exited: ' + repr(errors))
        return json.loads(line)

    async def command(action, **kwargs):
        bridge.stdin.write((json.dumps({'action': action, **kwargs}) + '\n').encode())
        await bridge.stdin.drain()
        return await bridge_read()

    try:
        source = await start_source('source_a')
        thread = (await source['client'].call('thread/start', {'cwd': str(workspace)}))['thread']['id']
        report['originalThreadId'] = thread
        name = 'Existing named Codex conversation'
        await source['client'].call('thread/name/set', {'threadId': thread, 'name': name})
        await source_turn(source, thread, 'source-context-A')
        # Intentionally inherited wrong home: Rele must honor the explicit profile.
        bridge_env = {**env, 'CODEX_HOME': str(root / 'unused-profile')}
        bridge = await asyncio.create_subprocess_exec(shutil.which('node'), str(REPO / 'node_modules/tsx/dist/cli.mjs'),
            str(REPO / 'scripts/probe-managed-codex.ts'), '--executable', CLI, '--home', str(home),
            '--directory', str(workspace), '--thread', thread, cwd=REPO, env=bridge_env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        bridge_drain = asyncio.create_task(drain(bridge))
        ready = await bridge_read()
        assert ready['status']['queueSupported'], ready
        assert ready['runtimeProcessId'] != source['runtimePid']
        assert Path(ready['runtime']['codexHome']).resolve() == home.resolve()
        assert any(row['id'] == thread and row['name'] == name for row in ready['catalog'])
        report['checks']['managed_child_lists_original_id_and_name_without_resuming'] = True
        report['checks']['explicit_shared_profile_overrides_inherited_home'] = True
        waiting = await command('ingest', platform='slack', eventId='slack-1', text='slack-context-B')
        assert waiting['requests'][0]['status'] == 'queued', waiting
        assert waiting['requests'][0].get('error'), waiting
        assert not waiting['deliveries'] and len(records) == 1, waiting
        request_id = waiting['requests'][0]['id']
        report['checks']['foreign_writer_keeps_original_request_in_rele_queue'] = True
        await stop_source(source)
        completed = await command('wait')
        assert completed['requests'][0]['id'] == request_id and completed['requests'][0]['status'] == 'completed'
        assert len(completed['deliveries']) == 1 and completed['deliveries'][0]['origin']['platform'] == 'slack'
        assert completed['deliveries'][0]['status'] == 'sent'
        assert 'source-context-A' in json.dumps(records[1]) and 'managed-answer-1' in json.dumps(records[1])
        assert completed['runtimeProcessId'] == ready['runtimeProcessId']
        assert 'passive-peer-agent-context' in json.dumps(records[1])
        report['checks']['all_author_slack_context_precedes_authorized_task'] = True
        report['checks']['released_source_resumes_same_request_with_prior_exchange'] = True
        report['checks']['slack_result_delivered_only_to_its_origin'] = True
        source2 = await start_source('source_a_reopened')
        resumed = await source2['client'].call('thread/resume', {'threadId': thread, 'excludeTurns': True})
        assert resumed['thread']['id'] == thread
        await source_turn(source2, thread, 'source-return-context-C')
        assert 'slack-context-B' in json.dumps(records[2]) and 'managed-answer-2' in json.dumps(records[2])
        report['checks']['managed_thread_released_while_own_server_stays_alive'] = True
        report['checks']['second_process_resumes_original_id_with_rele_exchange'] = True
        await stop_source(source2)
        restarted = await command('restart')
        assert restarted['runtimeProcessId'] != ready['runtimeProcessId']
        assert len(restarted['requests']) == 1 and restarted['requests'][0]['id'] == request_id
        report['checks']['restart_stops_owned_child_and_preserves_rele_database'] = True
        await command('ingest', platform='telegram', eventId='telegram-1', text='telegram-context-D')
        final = await command('wait')
        assert len(final['requests']) == 2 and all(r['status'] == 'completed' for r in final['requests'])
        assert sorted(d['origin']['platform'] for d in final['deliveries']) == ['slack', 'telegram']
        telegram = next(d for d in final['deliveries'] if d['origin']['platform'] == 'telegram')
        assert telegram['body'] == 'managed-answer-4' and telegram['status'] == 'sent'
        assert all(marker in json.dumps(records[3]) for marker in ('source-context-A', 'slack-context-B', 'source-return-context-C'))
        report['checks']['telegram_continuation_has_complete_prior_shared_context'] = True
        report['checks']['telegram_result_delivered_only_to_its_origin'] = True
        assert (home / 'config.toml').read_text(encoding='utf-8') == config
        assert not (root / 'unused-profile').exists()
        report['checks']['user_config_unchanged_and_no_private_profile_created'] = True
        # Exercise Rele's actual createThread/injectContext path in a separate empty profile.
        before_fresh = len(records)
        fresh = (await command('fresh-context'))['freshContext']
        assert fresh['queueEstablished'] and fresh['namedBeforeRelease'] and fresh['releasedBeforeContext'] and fresh['receiptBeforeFirstModel'], fresh
        assert fresh['passiveTurnsStarted'] == 0 and fresh['turnsStarted'] == 1, fresh
        assert fresh['childExited'], fresh
        assert len(records) == before_fresh + 1, 'Fresh passive injection created an extra model call'
        assert fresh['text'] in json.dumps(records[before_fresh]), 'First managed request omitted passive context'
        assert fresh['answer'] == f'managed-answer-{before_fresh + 1}', fresh
        report['checks']['empty_profile_create_thread_establishes_queue_gate'] = True
        report['checks']['native_name_persists_new_thread_before_release_and_first_passive_context'] = True
        report['checks']['new_managed_thread_passive_context_persists_before_first_model_or_turn'] = True
        report['checks']['first_managed_model_request_contains_new_thread_passive_context'] = True
        stopped = await command('close')
        assert stopped['childExited'], stopped
        await asyncio.wait_for(bridge.wait(), 15)
        assert bridge.returncode == 0, errors
        report['checks']['shutdown_waits_for_owned_child_exit'] = True
        report['syntheticProviderRequests'] = len(records)
        assert len(records) == 5, records
        report['result'] = 'passed'
    except BaseException as exc:
        report['result'] = 'failed'
        report['exception'] = repr(exc)
        report['stderrTail'] = errors[-20:]
        raise
    finally:
        if bridge and bridge.returncode is None:
            # Closing stdin runs the driver's finally block and closes its owned child.
            bridge.stdin.close()
            try:
                await asyncio.wait_for(bridge.wait(), 15)
            except TimeoutError:
                bridge.kill()
                await bridge.wait()
        if bridge_drain:
            await bridge_drain
        for server in servers:
            with contextlib.suppress(Exception):
                await stop_source(server)
        await runner.cleanup()
        args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))


with tempfile.TemporaryDirectory(prefix='rele-m4-') as directory:
    asyncio.run(main(Path(directory)))

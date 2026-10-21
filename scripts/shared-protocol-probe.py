#!/usr/bin/env python3
"""Native shared daemon + real Rele adapter/Engine + Desktop NDJSON shim gate.

Only isolated profiles, complete npm vendor packages, fake Responses provider and
synthetic messenger channels are used. This does not test the actual Desktop GUI.
"""
import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import uuid

from aiohttp import web

VERSIONS = ['0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11']
REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
DRIVER = REPO / 'scripts/probe-shared-codex.ts'
SHIM = REPO / 'dist/server/codex-cli.js'


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-prefix', type=Path, required=True)
    parser.add_argument('--expected-version', choices=VERSIONS, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    binary = 'codex.exe' if os.name == 'nt' else 'codex'
    candidates = list(args.codex_prefix.glob(f'node_modules/@openai/codex-*/vendor/*/bin/{binary}'))
    if len(candidates) != 1:
        parser.error('Expected exactly one native CLI in the isolated npm prefix.')
    args.cli = candidates[0].resolve()
    args.package = args.cli.parent.parent
    manifest = args.package / 'codex-package.json'
    if not manifest.is_file():
        parser.error('Native shared gate requires a complete npm vendor package with codex-package.json.')
    metadata = json.loads(manifest.read_text())
    if metadata.get('entrypoint') != f'bin/{binary}' or metadata.get('version') != args.expected_version:
        parser.error('Native vendor package manifest does not match the selected version and executable.')
    if not NODE or not SHIM.is_file():
        parser.error('Build Rele including dist/server/codex-cli.js before the shared gate.')
    return args


class Rpc:
    """JSON-RPC client over the production Desktop shim's NDJSON stdio."""
    def __init__(self, process):
        self.process, self.pending, self.events = process, {}, []
        self.reader = asyncio.create_task(self.pump())

    async def pump(self):
        try:
            while raw := await self.process.stdout.readline():
                item = json.loads(raw)
                if 'method' not in item and item.get('id') in self.pending:
                    future = self.pending.pop(item['id'])
                    if not future.done():
                        future.set_result(item)
                else:
                    self.events.append(item)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError('Desktop fixture shim disconnected'))
            self.pending.clear()

    async def send(self, item):
        self.process.stdin.write((json.dumps(item) + '\n').encode())
        await self.process.stdin.drain()

    async def call(self, method, params=None):
        identifier = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        await self.send({'id': identifier, 'method': method, 'params': params or {}})
        response = await asyncio.wait_for(future, 30)
        assert 'result' in response, response
        return response['result']

    async def wait(self, predicate, timeout=30):
        async def poll():
            while True:
                for event in self.events:
                    if predicate(event):
                        return event
                if self.reader.done():
                    self.reader.result()
                    raise ConnectionError('Desktop fixture event stream ended')
                await asyncio.sleep(.02)
        return await asyncio.wait_for(poll(), timeout)

    async def completed(self, turn):
        return await self.wait(lambda event: event.get('method') == 'turn/completed'
                               and event['params']['turn']['id'] == turn)

    async def close(self):
        if self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 10)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
                raise
        await self.reader
        assert self.process.returncode == 0, 'Desktop shim did not close cleanly'


class EngineDriver:
    def __init__(self, process):
        self.process = process

    async def read(self):
        line = await asyncio.wait_for(self.process.stdout.readline(), 55)
        if not line:
            raise RuntimeError('Shared Engine driver exited before responding')
        return json.loads(line)

    async def command(self, action, **fields):
        self.process.stdin.write((json.dumps({'action': action, **fields}) + '\n').encode())
        await self.process.stdin.drain()
        return await self.read()

    async def close(self):
        if self.process.returncode is not None:
            assert self.process.returncode == 0
            return
        result = await self.command('close')
        assert result['backendAlive'], 'Closing Rele stopped the shared native backend'
        await asyncio.wait_for(self.process.wait(), 15)
        assert self.process.returncode == 0


def frame(event):
    return ('data: ' + json.dumps(event) + '\n\n').encode()


async def gate(args, root):
    report = {'codexVersion': args.expected_version, 'platform': os.name, 'actualDesktopTested': False,
              'realModelRequests': 0, 'realMessengerRequests': 0, 'checks': {}}
    records, actions, holds, errors, drainers, processes = [], [], [], [], [], []

    async def provider(request):
        if request.method != 'POST' or not request.path.endswith('/responses'):
            return web.json_response({'data': []})
        body = await request.json()
        index = len(records) + 1
        action, event = actions.pop(0) if actions else ('final', None)
        records.append(body)
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        try:
            await response.write(frame({'type': 'response.created', 'response': {'id': f'resp-{index}'}}))
            if action == 'hold':
                await event.wait()
            if action == 'approval':
                item = {'type': 'function_call', 'name': 'exec_command', 'call_id': f'call-{index}',
                        'arguments': json.dumps({'cmd': 'echo rele-shared-no-execution', 'sandbox_permissions': 'require_escalated',
                                                'justification': 'Synthetic shared fixture: decline, never execute.'})}
            elif action == 'question':
                item = {'type': 'function_call', 'name': 'request_user_input', 'call_id': f'call-{index}',
                        'arguments': json.dumps({'questions': [{'id': 'continue', 'header': 'Continue',
                            'question': 'Continue the isolated shared fixture?', 'options': [
                                {'label': 'Yes', 'description': 'Continue the fixture.'},
                                {'label': 'No', 'description': 'Stop the fixture.'}]}]})}
            else:
                item = {'type': 'message', 'role': 'assistant', 'id': f'msg-{index}', 'phase': 'final_answer',
                        'content': [{'type': 'output_text', 'text': f'shared-answer-{index}'}]}
            await response.write(frame({'type': 'response.output_item.done', 'output_index': 0, 'item': item}))
            await response.write(frame({'type': 'response.completed', 'response': {'id': f'resp-{index}',
                'usage': {'input_tokens': 10, 'output_tokens': 3, 'total_tokens': 13}}}))
            await response.write_eof()
        except ConnectionError:
            pass  # The shared cancellation intentionally closes a held synthetic stream.
        return response

    app = web.Application()
    app.router.add_route('*', '/{tail:.*}', provider)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    config = f'''model="mock-model"
model_provider="mock_provider"
approval_policy="on-request"
approvals_reviewer="user"
sandbox_mode="read-only"
cli_auth_credentials_store="file"
[features]
plugins=false
[model_providers.mock_provider]
name="Rele isolated native shared fixture"
base_url="http://127.0.0.1:{port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
stream_max_retries=0
'''
    base_env = {key: value for key, value in os.environ.items() if key.upper() in
                ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR',
                 'COMSPEC', 'SYSTEMDRIVE', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA')}
    base_env.update({'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
                     'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                     'ALL_PROXY': 'http://127.0.0.1:9'})

    async def drain(process):
        while line := await process.stderr.readline():
            errors.append(line.decode(errors='replace').strip())
            del errors[:-40]

    async def spawn(command, env, cwd):
        process = await asyncio.create_subprocess_exec(*command, env=env, cwd=cwd, limit=2**26,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        processes.append(process)
        drainers.append(asyncio.create_task(drain(process)))
        return process

    async def output_and_exit(process, timeout):
        # stderr has one owner (drain); communicate() would compete for that pipe.
        process.stdin.close()
        try:
            output, _ = await asyncio.wait_for(asyncio.gather(process.stdout.read(), process.wait()), timeout)
            return output
        except TimeoutError:
            process.kill()
            await process.wait()
            raise

    async def windows_dpapi(env):
        # Match ConfigStore's PowerShell, input pipe and 15-second deadline, but
        # report only fixed stages from a synthetic CurrentUser roundtrip.
        script = '''$ErrorActionPreference='Stop'; try {
[Console]::Error.WriteLine('dpapi:started');
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
[Console]::Error.WriteLine('dpapi:assembly-ready');
$s=[Console]::In.ReadToEnd();
[Console]::Error.WriteLine('dpapi:input-read');
if ($s -cne 'rele-shared-dpapi-fixture') { throw 'Synthetic input mismatch' };
$b=[Text.Encoding]::UTF8.GetBytes($s);
$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Error.WriteLine('dpapi:protected');
$u=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);
if ([Text.Encoding]::UTF8.GetString($u) -cne $s) { throw 'Synthetic roundtrip mismatch' };
[Console]::Error.WriteLine('dpapi:roundtrip');
} catch { [Console]::Error.WriteLine('dpapi:failed'); exit 1 }'''
        process = await spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env, REPO)
        drainer = drainers[-1]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 15
        process.stdin.write(b'rele-shared-dpapi-fixture')
        await process.stdin.drain()
        try:
            output = await output_and_exit(process, max(0, deadline - loop.time()))
            await asyncio.wait_for(asyncio.shield(drainer), max(0, deadline - loop.time()))
        finally:
            report['windowsDpapiStages'] = [line for line in errors if line.startswith('dpapi:')]
        assert process.returncode == 0 and not output, 'Synthetic Windows DPAPI roundtrip failed'
        assert report['windowsDpapiStages'][-5:] == ['dpapi:started', 'dpapi:assembly-ready',
            'dpapi:input-read', 'dpapi:protected', 'dpapi:roundtrip'], 'Synthetic Windows DPAPI stages incomplete'
        report['checks']['windowsDpapi'] = True

    async def native(env, operation):
        process = await spawn([str(args.cli), 'app-server', 'daemon', operation], env, root)
        output = await output_and_exit(process, 20)
        assert process.returncode == 0, (operation, errors[-10:])
        return json.loads(output)

    async def driver(env, workspace, prepare=False, thread=None, profile_socket=None):
        command = [NODE, str(REPO / 'node_modules/tsx/dist/cli.mjs'), str(DRIVER),
                   '--executable', str(args.cli), '--home', env['CODEX_HOME'], '--directory', str(workspace)]
        if prepare or profile_socket:
            process = await spawn([*command, *(['--profile-socket', str(profile_socket)] if profile_socket else ['--prepare'])], env, REPO)
            output = await output_and_exit(process, 30)
            assert process.returncode == 0, errors[-10:]
            assert json.loads(output)['profileRejected' if profile_socket else 'prepared']
            return None, None
        if thread:
            command += ['--thread', thread]
        process = await spawn(command, env, REPO)
        client = EngineDriver(process)
        return client, await client.read()

    async def desktop(env, name):
        process = await spawn([NODE, str(SHIM), 'app-server', '--listen', 'stdio://'], env, REPO)
        client = Rpc(process)
        metadata = await client.call('initialize', {'clientInfo': {'name': name, 'version': '0.0.0'},
                                                     'capabilities': {'experimentalApi': True}})
        assert f'/{args.expected_version} ' in metadata['userAgent'], metadata['userAgent']
        assert Path(metadata['codexHome']).resolve() == Path(env['CODEX_HOME']).resolve()
        await client.send({'method': 'initialized'})
        return client

    async def wait_records(count):
        while len(records) < count:
            await asyncio.sleep(.02)

    async def scenario(order):
        directory = root / order
        home, workspace = directory / 'c', directory / 'w'
        home.mkdir(parents=True)
        workspace.mkdir()
        (home / 'config.toml').write_text(config, encoding='utf-8')
        env = {**base_env, 'CODEX_HOME': str(home), 'RELE_DATA_DIR': str(directory / 'rele')}
        # Disable the optional native updater before any start: package installation
        # must come entirely from the already installed, validated npm vendor tree.
        settings = home / 'app-server-daemon'
        if os.name == 'nt':
            # Let the native lifecycle create its exact owner-private Windows DACL.
            # Stop on this fresh profile only initializes state; it starts no backend.
            assert not settings.exists() and not (home / 'app-server-control/app-server-control.sock').exists()
            assert (await native(env, 'stop'))['status'] == 'notRunning'
            assert settings.is_dir()
        else:
            settings.mkdir()
        (settings / 'settings.json').write_text(json.dumps({'shutdownGraceSeconds': 1,
            'updater': {'autoUpdateEnabled': False}}), encoding='utf-8')
        engine = peer = observer = None
        try:
            if os.name == 'nt':
                await windows_dpapi(env)
            await driver(env, workspace, prepare=True)
            assert not (home / 'app-server-control/app-server-control.sock').exists()
            if order == 'rele-first':
                engine, ready = await driver(env, workspace)
                thread, pid = ready['threadId'], ready['runtimeProcessId']
                peer = await desktop(env, 'desktop_after_rele')
                await peer.call('thread/resume', {'threadId': thread, 'excludeTurns': True})
            else:
                peer = await desktop(env, 'desktop_before_rele')
                thread = (await peer.call('thread/start', {'cwd': str(workspace)}))['thread']['id']
                await peer.call('thread/name/set', {'threadId': thread, 'name': 'Original shared fixture'})
                await peer.call('thread/unsubscribe', {'threadId': thread})
                assert (await peer.call('thread/resume', {'threadId': thread, 'excludeTurns': True}))['thread']['id'] == thread
                # Existing Desktop chats have ordinary history. Native excludes an empty
                # metadata-only thread from thread/list, even after name/set.
                prior = (await peer.call('turn/start', {'threadId': thread,
                    'input': [{'type': 'text', 'text': f'{order}-desktop-prior-context'}]}))['turn']['id']
                await peer.completed(prior)
                engine, ready = await driver(env, workspace, thread=thread)
                pid = ready['runtimeProcessId']
                assert ready['catalogValidated']
                report['checks']['desktop_first_production_catalog_selects_original_existing_thread'] = True
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            assert ready['status']['queueSupported'] and ready['status']['transport'] == 'shared', ready['status']
            report['checks'][f'{order}_same_original_id_profile_pid'] = True
            if order == 'rele-first':
                wrong_home = directory / 'other-profile'
                wrong_home.mkdir()
                before_requests = len(records)
                before_threads = await peer.call('thread/list', {})
                await driver({**env, 'CODEX_HOME': str(wrong_home), 'RELE_DATA_DIR': str(directory / 'other-rele')},
                    workspace, profile_socket=home / 'app-server-control/app-server-control.sock')
                assert not (wrong_home / 'app-server-control/app-server-control.sock').exists()
                assert len(records) == before_requests and (await peer.call('thread/list', {})) == before_threads
                assert (await peer.call('server/diagnostics'))['process']['id'] == pid
                report['checks']['native_initialize_wrong_profile_rejected_before_thread_or_model_work'] = True
            first, again = await native(env, 'start'), await native(env, 'start')
            assert first['status'] == again['status'] == 'alreadyRunning'
            assert Path(first['socketPath']).resolve() == (home / 'app-server-control/app-server-control.sock').resolve()
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            installed = Path(first['managedCodexPath']).parent.parent / 'codex-package.json'
            assert installed.is_file() and installed.read_bytes() == (args.package / 'codex-package.json').read_bytes()
            assert not (settings / 'daemon-updater.pid').exists()
            report['checks'][f'{order}_native_start_idempotent_local_package_only'] = True
            before = len(records)
            if order == 'rele-first':
                turn = (await peer.call('turn/start', {'threadId': thread,
                    'input': [{'type': 'text', 'text': f'{order}-desktop-prior-context'}]}))['turn']['id']
                await peer.completed(turn)
            else:
                before -= 1
            await engine.command('ingest', platform='slack', eventId=f'{order}-slack', text=f'{order}-slack-request')
            done = await engine.command('wait')
            assert len(done['requests']) == 1 and done['requests'][0]['status'] == 'completed'
            assert len(done['deliveries']) == 1 and done['deliveries'][0]['origin']['platform'] == 'slack'
            assert done['deliveries'][0]['status'] == 'sent'
            assert all(marker in json.dumps(records[before + 1]) for marker in
                       (f'{order}-desktop-prior-context', 'shared-passive-agent-context', f'{order}-slack-request'))
            report['checks'][f'{order}_slack_full_context_and_exact_origin'] = True
            if order == 'desktop-first':
                await engine.close()
                engine = None
                assert (await peer.call('server/diagnostics'))['process']['id'] == pid
                report['checks']['desktop_first_rele_close_preserves_native_owner'] = True
                return
            # A real Rele request is active while its client/engine process is closed.
            hold = asyncio.Event(); holds.append(hold); actions.append(('hold', hold))
            before = len(records)
            await engine.command('ingest', platform='telegram', eventId='held-telegram', text='held-original-request', loseAck=True)
            await asyncio.wait_for(wait_records(before + 1), 25)
            running = await engine.command('wait', status='running')
            assert running['droppedQueueAcks'] == 1, 'The synthetic queue ACK was not withheld'
            request = next(row for row in running['requests'] if row['eventId'] == 'held-telegram')
            await engine.close(); engine = None
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            assert (await peer.call('thread/read', {'threadId': thread}))['thread']['status']['type'] != 'idle'
            engine, restarted = await driver(env, workspace, thread=thread)
            assert restarted['runtimeProcessId'] == pid
            hold.set()
            completed = await engine.command('wait')
            recovered = next(row for row in completed['requests'] if row['id'] == request['id'])
            assert recovered['status'] == 'completed' and recovered['origin'] == request['origin']
            assert len(records) == before + 1, 'Rele restart replayed an accepted native request'
            assert any(row['requestId'] == request['id'] and row['origin']['platform'] == 'telegram' and row['status'] == 'sent'
                       for row in completed['deliveries'])
            report['checks']['rele_restart_after_lost_ack_preserves_active_native_turn_uuid_without_resend'] = True
            # An origin-owned approval is resolved by the real Engine; Desktop sees it.
            actions.append(('approval', None))
            await engine.command('ingest', platform='telegram', eventId='approval', text='shared-approval-request')
            pending = await engine.command('wait', status='waiting_approval')
            approval = next(item for item in pending['approvals'] if item['status'] == 'pending')
            wire = await peer.wait(lambda event: event.get('method') == 'item/commandExecution/requestApproval'
                                   and event['params'].get('turnId') == approval['turnId'])
            assert wire['id'] == approval['rpcId']
            await engine.command('answer', approvalId=approval['id'])
            await peer.wait(lambda event: event.get('method') == 'serverRequest/resolved'
                            and event['params'].get('requestId') == wire['id'])
            await engine.command('wait')
            report['checks']['origin_engine_declines_approval_and_desktop_observes_resolution'] = True
            # Desktop's native question is replayed to a late second shim subscriber.
            actions.append(('question', None))
            question_turn = (await peer.call('turn/start', {'threadId': thread,
                'collaborationMode': {'mode': 'plan', 'settings': {'model': 'mock-model',
                    'reasoning_effort': None, 'developer_instructions': None}},
                'input': [{'type': 'text', 'text': 'shared-native-question'}]}))['turn']['id']
            question = await peer.wait(lambda event: event.get('method') == 'item/tool/requestUserInput'
                                      and event['params'].get('turnId') == question_turn)
            observer = await desktop(env, 'desktop_question_peer')
            await observer.call('thread/resume', {'threadId': thread, 'excludeTurns': True})
            replay = await observer.wait(lambda event: event.get('method') == 'item/tool/requestUserInput'
                                        and event['params'].get('turnId') == question_turn)
            assert replay['id'] == question['id'] and replay['params'] == question['params']
            await observer.send({'id': replay['id'], 'result': {'answers': {'continue': {'answers': ['Yes']}}}})
            await peer.completed(question_turn)
            assert 'Yes' in json.dumps(records[-1])
            report['checks']['desktop_question_late_replay_and_peer_answer_share_owner'] = True
            hold_cancel = asyncio.Event(); holds.append(hold_cancel); actions.append(('hold', hold_cancel))
            before = len(records)
            await engine.command('ingest', platform='telegram', eventId='cancel', text='shared-cancel-request')
            await asyncio.wait_for(wait_records(before + 1), 25)
            running = await engine.command('wait', status='running')
            cancel = next(row for row in running['requests'] if row['eventId'] == 'cancel')
            await engine.command('cancel', requestId=cancel['id'])
            aborted = await peer.completed(cancel['turnId'])
            assert aborted['params']['turn']['status'] == 'interrupted'
            hold_cancel.set()
            await engine.command('wait')
            report['checks']['origin_engine_cancels_exact_native_turn_seen_by_desktop'] = True
            preserved = {row['id'] for row in (await engine.command('snapshot'))['requests']}
            await engine.close(); engine = None
            await observer.close(); observer = None
            await peer.close(); peer = None
            await native(env, 'stop')
            fresh = await native(env, 'start')
            assert fresh['status'] == 'started'
            await native(env, 'restart')
            peer = await desktop(env, 'desktop_after_backend_restart')
            new_pid = (await peer.call('server/diagnostics'))['process']['id']
            assert new_pid != pid
            assert (await peer.call('thread/resume', {'threadId': thread, 'excludeTurns': True}))['thread']['id'] == thread
            engine, after_backend = await driver(env, workspace, thread=thread)
            assert after_backend['runtimeProcessId'] == new_pid and after_backend['threadId'] == thread
            assert {row['id'] for row in after_backend['requests']} == preserved
            before = len(records)
            await engine.command('ingest', platform='telegram', eventId='after-native-restart', text='after-native-restart-request')
            queued = await engine.command('wait', status='starting')
            continued = next(row for row in queued['requests'] if row['eventId'] == 'after-native-restart')
            assert len(records) == before, 'An interrupted native queue resumed without explicit continuation'
            await engine.command('resume', requestId=continued['id'])
            await engine.command('wait')
            report['checks']['interrupted_native_queue_explicit_continuation_without_resend'] = True
            assert all(marker in json.dumps(records[before]) for marker in
                       ('rele-first-desktop-prior-context', 'rele-first-slack-request', 'held-original-request'))
            report['checks']['native_stop_start_restart_restores_original_id_history_and_rele_records'] = True
            assert (home / 'config.toml').read_text(encoding='utf-8') == config
            report['checks']['isolated_native_user_config_unchanged'] = True
        finally:
            for event in holds:
                event.set()
            primary_error = sys.exc_info()[1]
            cleanup_errors = []
            for client in (engine, observer, peer):
                if client:
                    try:
                        await client.close()
                    except Exception as error:
                        cleanup_errors.append(repr(error))
            try:
                stopped = await native(env, 'stop')
                assert stopped['status'] in ('stopped', 'notRunning')
            except Exception as error:
                cleanup_errors.append(repr(error))
            if cleanup_errors:
                report.setdefault('cleanupErrors', []).extend(cleanup_errors)
                if primary_error is None:
                    raise RuntimeError(f'Isolated fixture cleanup failed: {cleanup_errors}')

    try:
        await scenario('rele-first')
        await scenario('desktop-first')
        report['syntheticProviderRequests'] = len(records)
        assert all(report['checks'].values())
        report['result'] = 'passed'
    except BaseException as error:
        report['result'] = 'failed'
        report['exception'] = repr(error)
        report['stderrTail'] = errors[-20:]
        raise
    finally:
        for hold in holds:
            hold.set()
        # Catch setup failures before a client wrapper has been returned, too.
        # These are only fixture-owned clients/commands, never the native daemon.
        for process in processes:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 8)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        await asyncio.wait_for(asyncio.gather(*drainers, return_exceptions=True), 10)
        await runner.cleanup()
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    args = arguments()
    with tempfile.TemporaryDirectory(prefix='rs-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        asyncio.run(gate(args, Path(directory)))

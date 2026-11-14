#!/usr/bin/env python3
"""Real shared Codex/Engine gate: Linux native UDS, Windows installed direct WS owner.

Only isolated profiles, complete native packages or signed Desktop payloads,
a fake Responses provider and synthetic messenger channels are used. The optional
Desktop mode tests real backend bytes and production bootstrap, never the GUI.
"""
import argparse
import asyncio
import contextlib
import difflib
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import time
import uuid

from aiohttp import web
import websockets
from websockets.exceptions import ConnectionClosedError
from websockets.protocol import State

VERSIONS = ['0.163.0', '0.163.0-alpha.10.2', '0.163.0-alpha.11', '0.163.0-alpha.11.2', '0.164.0-alpha.11.1', '0.165.0-alpha.1.2', '0.166.0-alpha.5.1', '0.166.0-alpha.6', '0.167.0-alpha.3.2', '0.167.0-alpha.4.1']
REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
DRIVER = REPO / 'scripts/probe-shared-codex.ts'
SHIM = REPO / 'dist/server/codex-cli.js'
ENGINE_READ_TIMEOUT_SECONDS = 70
ENGINE_WAIT_READ_TIMEOUT_SECONDS = 120
ENGINE_CANCEL_READ_TIMEOUT_SECONDS = 720
# backgroundTerminals performs two Windows native identity proofs, each bounded at 30s.
ENGINE_SHARED_SHELL_START_TIMEOUT_SECONDS = 65


def safe_error_type(error):
    name = type(error).__name__
    return name if re.fullmatch(r'[A-Za-z]{1,48}', name) else 'other'


async def record_cleanup_error(errors, operation, resource, action, process_pid=None, owner_pid=None):
    started = time.monotonic()
    try:
        await action()
    except Exception as error:
        errors.append({
            'operation': operation if operation in ('engine.close', 'observer.close', 'peer.close', 'native.stop') else 'other',
            'elapsedMs': max(0, min(600000, round((time.monotonic() - started) * 1000))),
            'errorType': safe_error_type(error),
            'resource': resource if resource in ('engine-driver-process', 'desktop-shim-process', 'direct-websocket', 'native-owner', 'native-daemon') else 'other',
            **({'processPid': process_pid} if isinstance(process_pid, int) and not isinstance(process_pid, bool) and process_pid > 0 else {}),
            **({'ownerPid': owner_pid} if isinstance(owner_pid, int) and not isinstance(owner_pid, bool) and owner_pid > 0 else {}),
        })


def cleanup_failure_message(primary_error, cleanup_errors):
    if primary_error is not None or not cleanup_errors:
        return None
    operations = ', '.join(error['operation'] if error.get('operation') in ('engine.close', 'observer.close', 'peer.close', 'native.stop') else 'other'
        for error in cleanup_errors[:8])
    return f'Isolated fixture cleanup failed: {operations}'


def public_console_report(report):
    checks = report.get('checks') if isinstance(report.get('checks'), dict) else {}
    output = {
        'result': report.get('result') if report.get('result') in ('passed', 'failed') else 'unknown',
        'checksPassed': sum(value is True for value in checks.values()),
        'checksFailed': sum(value is False for value in checks.values()),
        'cleanupErrors': [],
        'retainedFixture': bool(report.get('retainedFixture')),
    }
    failure_type = report.get('failureType')
    if isinstance(failure_type, str) and re.fullmatch(r'[A-Za-z]{1,48}', failure_type):
        output['failureType'] = failure_type
    cleanup_errors = report.get('cleanupErrors')
    if not isinstance(cleanup_errors, list):
        cleanup_errors = []
    for error in cleanup_errors[-8:]:
        if not isinstance(error, dict):
            continue
        output['cleanupErrors'].append({
            'operation': error.get('operation') if error.get('operation') in ('engine.close', 'observer.close', 'peer.close', 'native.stop') else 'other',
            'errorType': error.get('errorType') if isinstance(error.get('errorType'), str) and re.fullmatch(r'[A-Za-z]{1,48}', error['errorType']) else 'other',
            'elapsedMs': max(0, min(600000, error.get('elapsedMs', 0))) if isinstance(error.get('elapsedMs'), int) and not isinstance(error.get('elapsedMs'), bool) else 0,
            'resource': error.get('resource') if error.get('resource') in ('engine-driver-process', 'desktop-shim-process', 'direct-websocket', 'native-owner', 'native-daemon') else 'other',
        })
    return output


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--codex-prefix', type=Path)
    source.add_argument('--codex', type=Path, help='Native executable inside a complete extracted Codex package.')
    source.add_argument('--desktop-bundle', type=Path)
    parser.add_argument('--desktop-inventory', type=Path)
    parser.add_argument('--installed-desktop', action='store_true')
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--windows-app-template', type=Path)
    parser.add_argument('--windows-runtime', choices=['source', 'packaged'], default='source')
    args = parser.parse_args()
    if args.expected_version not in VERSIONS and not args.desktop_bundle:
        parser.error('Unlisted versions require a measured Desktop inventory.')
    args.retain_fixture = False
    if args.installed_desktop and (os.name != 'nt' or not args.desktop_bundle or not args.desktop_inventory):
        parser.error('Installed Desktop mode requires Windows, --desktop-bundle and the signed --desktop-inventory.')
    if os.name == 'nt':
        if not args.windows_app_template:
            parser.error('Windows shared gate requires --windows-app-template with Rele.exe and dist/native/Rele.Process.exe.')
        args.windows_app_template = args.windows_app_template.resolve(strict=True)
        for name in ['Rele.exe', 'dist/native/Rele.Process.exe']:
            if not (args.windows_app_template / name).is_file():
                parser.error(f'Windows application template is missing {name}.')
        if args.windows_runtime == 'packaged':
            for name in ['dist/server/engine.js', 'dist/server/codex.js', 'node_modules/ws/package.json']:
                if not (args.windows_app_template / name).is_file():
                    parser.error(f'Packaged Windows template is missing {name}.')
    elif args.windows_app_template or args.windows_runtime != 'source':
        parser.error('Windows fixture options require Windows.')
    binary = 'codex.exe' if os.name == 'nt' else 'codex'
    args.inventory = None
    if args.desktop_bundle:
        if os.name != 'nt' or not args.desktop_inventory:
            parser.error('Actual Desktop mode requires Windows and the signed package inventory.')
        args.desktop_bundle = args.desktop_bundle.resolve(strict=True)
        args.inventory = json.loads(args.desktop_inventory.read_text(encoding='utf-8-sig'))
        evidence = args.inventory
        if (evidence.get('result') != 'passed' or not evidence.get('nativeGatePrepared')
                or evidence.get('backendVersion') != args.expected_version
                or evidence.get('package', {}).get('signature', {}).get('status') != 'Valid'
                or evidence.get('package', {}).get('identity', {}).get('name') not in ('OpenAI.Codex', 'OpenAI.ChatGPT')
                or evidence['package']['identity'].get('architecture') != 'x64'):
            parser.error('Expected a trusted x64 Desktop inventory with the exact measured backend version.')
        args.cli = args.desktop_bundle / 'app/resources/codex.exe'
        args.package = None
    else:
        if args.codex:
            args.cli = args.codex.resolve(strict=True)
        else:
            candidates = list(args.codex_prefix.glob(f'node_modules/@openai/codex-*/vendor/*/bin/{binary}'))
            if len(candidates) != 1:
                parser.error('Expected exactly one native CLI in the isolated npm prefix.')
            args.cli = candidates[0].resolve()
        args.package = args.cli.parent.parent
        manifest = args.package / 'codex-package.json'
        if not manifest.is_file():
            parser.error('Native shared gate requires a complete package with codex-package.json.')
        metadata = json.loads(manifest.read_text())
        if metadata.get('entrypoint') != f'bin/{binary}' or metadata.get('version') != args.expected_version:
            parser.error('Native vendor package manifest does not match the selected version and executable.')
    if not NODE or os.name != 'nt' and not SHIM.is_file():
        parser.error('Build Rele including dist/server/codex-cli.js before the shared gate.')
    return args


class Rpc:
    """Same peer protocol over direct Windows WS or the existing Linux NDJSON shim."""
    def __init__(self, process=None, ws=None):
        self.process, self.ws, self.pending, self.events = process, ws, {}, []
        self.reader = asyncio.create_task(self.pump())

    async def pump(self):
        try:
            async def messages():
                if self.ws is not None:
                    async for raw in self.ws:
                        yield raw
                else:
                    while raw := await self.process.stdout.readline():
                        yield raw
            async for raw in messages():
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
        if self.ws is not None:
            await self.ws.send(json.dumps(item))
            return
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
        if self.ws is not None:
            locally_open = self.ws.state is State.OPEN and not self.reader.done()
            await self.ws.close()
            try:
                await self.reader
            except ConnectionClosedError as error:
                # Native WS drops its writer on Close instead of echoing the frame.
                if not (locally_open and error.rcvd is None and error.sent is not None
                        and error.sent.code == 1000 and error.sent.reason == ''):
                    raise
            return
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

    async def read(self, timeout=ENGINE_READ_TIMEOUT_SECONDS):
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        if not line:
            raise RuntimeError('Shared Engine driver exited before responding')
        return json.loads(line)

    async def command(self, action, **fields):
        self.process.stdin.write((json.dumps({'action': action, **fields}) + '\n').encode())
        await self.process.stdin.drain()
        # Cancellation may repeat Windows generation proofs, each with 30-second subprocess limits.
        timeout = ENGINE_CANCEL_READ_TIMEOUT_SECONDS if action == 'cancel' else ENGINE_WAIT_READ_TIMEOUT_SECONDS if action == 'wait' else ENGINE_READ_TIMEOUT_SECONDS
        return await self.read(timeout)

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
    report = {'codexVersion': args.expected_version, 'platform': os.name, 'actualDesktopTested': False, 'actualDesktopGui': False,
              'actualDesktopBundle': bool(args.desktop_bundle), 'installedDesktop': args.installed_desktop, 'actualDesktopBackendExecuted': False,
              'realModelRequests': 0, 'realMessengerRequests': 0, 'checks': {}}
    records, actions, holds, errors, drainers, processes, provider_trace = [], [], [], [], [], [], []
    native_executables = {}
    windows_fixtures = {}
    if os.name == 'nt':
        with args.cli.open('rb') as stream:
            native_source_sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
        report['windowsNativeSourceSha256'] = native_source_sha256
        report['windowsSharedRuntime'] = args.windows_runtime
        report['windowsPeerTransport'] = 'direct-websocket'
        report['windowsControlHashes'] = {name: hashlib.sha256((args.windows_app_template / name).read_bytes()).hexdigest()
            for name in ['Rele.exe', 'dist/native/Rele.Process.exe']}
        runtime_files = ['dist/server/engine.js', 'dist/server/codex.js', 'dist/server/codex-shared.js'] if args.windows_runtime == 'packaged' else ['src/server/engine.ts', 'src/server/codex.ts', 'src/server/codex-shared.ts']
        runtime_root = args.windows_app_template if args.windows_runtime == 'packaged' else REPO
        report['windowsRuntimeHashes'] = {name: hashlib.sha256((runtime_root / name).read_bytes()).hexdigest() for name in runtime_files}

    async def provider(request):
        if request.method != 'POST' or not request.path.endswith('/responses'):
            return web.json_response({'data': []})
        body = await request.json()
        index = len(records) + 1
        latest_user = next((item for item in reversed(body.get('input', [])) if item.get('role') == 'user'), {})
        initial = any(part.get('text', '').endswith('На это сообщение ответь NOREPLY.')
                      for part in latest_user.get('content', []) if isinstance(part, dict))
        action, event = ('initial', None) if initial else actions.pop(0) if actions else ('final', None)
        trace = {'index': index, 'action': action, 'result': 'pending'}
        provider_trace.append(trace)
        records.append(body)
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        try:
            await response.write(frame({'type': 'response.created', 'response': {'id': f'resp-{index}'}}))
            if action == 'hold':
                await event.wait()
            if action == 'shell':
                item = {'type': 'function_call', 'name': 'exec_command', 'call_id': f'call-{index}',
                        'arguments': json.dumps(event)}
            elif action == 'approval':
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
                        'content': [{'type': 'output_text', 'text': 'NOREPLY' if initial else f'shared-answer-{index}'}]}
            if args.expected_version == '0.166.0-alpha.6' and item['type'] == 'function_call':
                tools = body.get('tools', [])
                if item['name'] == 'request_user_input':
                    question_specs = [tool for tool in tools if tool.get('type') == 'function' and tool.get('name') == item['name']]
                    assert len(question_specs) == 1 and question_specs[0].get('parameters', {}).get('properties', {}).get('questions', {}).get('type') == 'array' and 'questions' in question_specs[0]['parameters'].get('required', []), 'Native did not advertise the direct question function'
                else:
                    assert len([tool for tool in tools if tool.get('type') == 'custom' and tool.get('name') == 'exec']) == 1, 'Native did not advertise the custom exec tool'
                    item = {'type': 'custom_tool_call', 'name': 'exec', 'call_id': item['call_id'],
                            'input': 'text(await tools.' + item['name'] + '(' + item['arguments'] + '));'}
            await response.write(frame({'type': 'response.output_item.done', 'output_index': 0, 'item': item}))
            await response.write(frame({'type': 'response.completed', 'response': {'id': f'resp-{index}',
                'usage': {'input_tokens': 10, 'output_tokens': 3, 'total_tokens': 13}}}))
            await response.write_eof()
            trace['result'] = 'sent'
        except ConnectionError:
            trace['result'] = 'disconnected'
            pass  # The shared cancellation intentionally closes a held synthetic stream.
        return response

    app = web.Application()
    app.router.add_route('*', '/{tail:.*}', provider)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    code_mode_feature = 'code_mode=true\ncode_mode_host=true\n' if args.expected_version == '0.166.0-alpha.6' else ''
    config = f'''model="mock-model"
model_provider="mock_provider"
approval_policy="on-request"
approvals_reviewer="user"
sandbox_mode="read-only"
cli_auth_credentials_store="file"
[features]
plugins=false
{code_mode_feature}[model_providers.mock_provider]
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
    if args.desktop_bundle:
        # Keep installed Appx discovery real; copied bundles use the existing isolated install root.
        local = root / 'desktop-user/AppData/Local'
        local.mkdir(parents=True, exist_ok=True)
        install = args.desktop_bundle if args.installed_desktop else local / 'Programs/ChatGPT'
        if not args.installed_desktop:
            shutil.copytree(args.desktop_bundle, install)
        for row in args.inventory['inventory']:
            source = install / row['path']
            assert source.is_file() and source.stat().st_size == row['size'], row['path']
            with source.open('rb') as stream:
                assert row['sha256'] and hashlib.file_digest(stream, 'sha256').hexdigest() == row['sha256'], row['path']
        assert not list(install.rglob('codex-package.json'))
        base_env.update({'LOCALAPPDATA': str(local), 'APPDATA': str(local.parent / 'Roaming')})
        assert shutil.which('codex', path=base_env.get('PATH')) is None, 'Actual Desktop gate must not find an npm/manual CLI on PATH'
        args.cli = install / 'app/resources/codex.exe'
        report['desktopPackage'] = args.inventory['package']
        report['checks']['actual_signed_desktop_files_without_npm_or_native_manifest'] = True


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

    async def prepare_windows(env, directory):
        app_dir = directory / 'a'
        app_dir.mkdir()
        shutil.copy2(args.windows_app_template / 'Rele.exe', app_dir / 'Rele.exe')
        if args.windows_runtime == 'packaged':
            shutil.copytree(args.windows_app_template / 'dist', app_dir / 'dist')
            shutil.copytree(args.windows_app_template / 'node_modules/ws', app_dir / 'node_modules/ws')
            (app_dir / 'package.json').write_text('{"type":"module","private":true}')
        else:
            (app_dir / 'dist/native').mkdir(parents=True)
            shutil.copy2(args.windows_app_template / 'dist/native/Rele.Process.exe', app_dir / 'dist/native/Rele.Process.exe')
        data = Path(env['RELE_DATA_DIR'])
        data.mkdir()
        process = await spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
            '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], env, root)
        sid = (await output_and_exit(process, 15)).decode().strip()
        assert process.returncode == 0 and sid.startswith('S-1-5-21-') and all(c in 'S0123456789-' for c in sid), 'Unconfirmed fixture owner SID'
        task = 'Rele-Shared-' + uuid.uuid4().hex
        metadata = {'OwnerSid': sid, 'DataDirectory': str(data), 'TaskName': task, 'Port': 0,
            'CodexHome': env['CODEX_HOME'], 'DesktopIntegrationRequested': False, 'DesktopIntegrationOwned': False}
        settings_file = app_dir / 'rele-install.json'
        settings_file.write_text(json.dumps(metadata), encoding='utf-8')
        windows_fixtures[env['CODEX_HOME']] = {'application': app_dir, 'target': {
            'executable': str(args.cli), 'transport': 'shared', 'endpoint': '', 'codexHome': env['CODEX_HOME'],
            'installSettingsPath': str(settings_file), 'fixtureDataDirectory': str(data), 'fixtureTaskName': task}}

    async def owner_stop(env):
        fixture = windows_fixtures[env['CODEX_HOME']]
        # Reuse installer acceptance's task/principal/action/hash/birth guards; no generic task kill.
        script = '''import { pathToFileURL } from 'node:url';
const { captureInstallerOwner, stopInstallerCodex } = await import(pathToFileURL(process.argv[1]).href);
const target = JSON.parse(process.argv[2]);
await captureInstallerOwner(target);
if (!target.desktopOwner) { console.log(JSON.stringify({status:'notRunning'})); }
else { console.log(JSON.stringify(stopInstallerCodex(target))); }
'''
        process = await spawn([NODE, '--input-type=module', '-e', script,
            str(REPO / 'scripts/installer-codex-fixture.mjs'), json.dumps(fixture['target'])], env, root)
        # The nested owner shutdown helper has a 75-second Windows deadline.
        output = await output_and_exit(process, 90)
        assert process.returncode == 0, ('owner-stop', errors[-10:])
        return json.loads(output)

    async def native(env, operation):
        if os.name == 'nt':
            fixture = windows_fixtures[env['CODEX_HOME']]
            if operation in ('stop', 'restart'):
                stopped = await owner_stop(env)
                if operation == 'stop':
                    return stopped
            executable = native_executables.get(env['CODEX_HOME'], args.cli)
            process = await spawn([str(fixture['application'] / 'Rele.exe'), 'codex-start', '--quiet',
                '--codex-executable', str(executable), '--codex-home', env['CODEX_HOME']], env, root)
            output = await output_and_exit(process, 45)
            assert process.returncode == 0, (operation, errors[-10:])
            receipt = json.loads(output)
            assert receipt['status'] in ('started', 'alreadyRunning') and receipt['codexHome'] == env['CODEX_HOME']
            assert Path(receipt['executable']).resolve() == executable.resolve()
            with executable.open('rb') as stream:
                assert receipt['executableSha256'] == native_source_sha256 == hashlib.file_digest(stream, 'sha256').hexdigest()
            fixture['endpoint'] = receipt['endpoint']
            fixture['target']['endpoint'] = receipt['endpoint']
            return receipt
        command = [str(native_executables.get(env['CODEX_HOME'], args.cli)), 'app-server', 'daemon', operation]
        process = await spawn(command, env, root)
        output = await output_and_exit(process, 20)
        assert process.returncode == 0, (operation, errors[-10:])
        return json.loads(output)

    def remember_windows_native(env, ready):
        executable = Path(ready['status']['executable']).resolve(strict=True)
        source = args.cli.resolve(strict=True)
        with source.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == native_source_sha256, 'Original native executable changed'
        assert f'/{args.expected_version} ' in ready['runtime']['userAgent']
        assert Path(ready['runtime']['codexHome']).resolve() == Path(env['CODEX_HOME']).resolve()
        if executable != source:
            cache = Path(env['RELE_DATA_DIR']).resolve(strict=True) / 'codex-desktop-packages'
            package = executable.parent.parent
            assert cache.resolve(strict=True) == cache and package.parent == cache and executable == package / 'bin/codex.exe'
            assert len(package.name) == 64 and all(character in '0123456789abcdef' for character in package.name)
            manifest = (package / 'codex-package.json').read_bytes()
            assert hashlib.sha256(manifest).hexdigest() == package.name, 'Prepared native manifest changed'
            proof = ready['preparedRuntime']
            assert Path(proof['executable']).resolve() == executable and Path(proof['sourceExecutable']).resolve() == source
            assert proof['sourceSelection'] == ready['configuredExecutable'] and proof['sourceUnchanged'] is True
            assert proof['version'] == args.expected_version and proof['executableSha256'] == native_source_sha256
        native_executables[env['CODEX_HOME']] = executable
        windows_fixtures[env['CODEX_HOME']]['target']['executable'] = str(executable)

    async def driver(env, workspace, prepare=False, thread=None, profile_socket=None, expected_error=None):
        command = [NODE, str(REPO / 'node_modules/tsx/dist/cli.mjs'), str(DRIVER),
                   '--executable', 'codex' if args.desktop_bundle and not args.installed_desktop else str(args.cli), '--home', env['CODEX_HOME'], '--directory', str(workspace)]
        if os.name == 'nt':
            app_dir = windows_fixtures.get(env['CODEX_HOME'], windows_fixtures[next(iter(windows_fixtures))])['application']
            command += ['--runtime-directory' if args.windows_runtime == 'packaged' else '--windows-install-dir', str(app_dir)]
        if prepare or profile_socket or expected_error:
            option = ['--expect-error', expected_error] if expected_error else ['--profile-socket', str(profile_socket)] if profile_socket else ['--prepare']
            process = await spawn([*command, *option], env, REPO)
            output = await output_and_exit(process, 30)
            assert process.returncode == 0, errors[-10:]
            result = json.loads(output)
            assert result['expectedError'] == expected_error if expected_error else result['profileRejected' if profile_socket else 'prepared']
            return None, None
        if thread:
            command += ['--thread', thread]
        driver_env = env
        if os.name == 'nt' and os.environ.get('RELE_CI_SHARED_DIAGNOSTICS') == '1':
            driver_env = {**env, 'RELE_CI_SHARED_DIAGNOSTICS': '1'}
        process = await spawn(command, driver_env, REPO)
        client = EngineDriver(process)
        ready = await client.read()
        if os.name == 'nt':
            remember_windows_native(env, ready)
        return client, ready

    async def desktop(env, name, private=False, plugin_helpers=False):
        command = [str(args.cli)] if private else [NODE, str(SHIM)]
        enabled = str(plugin_helpers).lower()
        # Exact current Desktop's ordinary local argv, including its global -c prefix.
        flags = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled',
            '-c', f'mcp_servers.codex_app.enabled={enabled}',
            '-c', f'mcp_servers.code-review.enabled={enabled}']
        if os.name == 'nt' and not private:
            receipt = await native(env, 'start')
            deadline = asyncio.get_running_loop().time() + 20
            while True:
                try:
                    ws = await websockets.connect(receipt['endpoint'], proxy=None, open_timeout=1, max_size=2**26)
                    break
                except (OSError, TimeoutError):
                    if asyncio.get_running_loop().time() >= deadline:
                        raise
                    await asyncio.sleep(.1)
            client = Rpc(ws=ws)
        else:
            process = await spawn([*command, *flags], env, REPO)
            client = Rpc(process)
        metadata = await client.call('initialize', {'clientInfo': {'name': name, 'version': '0.0.0'},
                                                     'capabilities': {'experimentalApi': True}})
        assert f'/{args.expected_version} ' in metadata['userAgent'], metadata['userAgent']
        assert Path(metadata['codexHome']).resolve() == Path(env['CODEX_HOME']).resolve()
        await client.send({'method': 'initialized'})
        if not private and os.name != 'nt':
            variants = report.setdefault('desktopStartupArgv', [])
            if flags not in variants:
                variants.append(flags)
        return client

    async def held_request_evidence(engine, peer, thread):
        evidence = {'providerRequestCount': len(records)}
        try:
            engine_snapshot = await asyncio.wait_for(engine.command('snapshot'), 5)
            evidence['engineRequests'] = [
                {key: row.get(key) for key in ('eventId', 'status', 'turnId')}
                for row in engine_snapshot.get('requests', [])[-8:]
            ]
            evidence['engineApprovals'] = [
                {key: row.get(key) for key in ('id', 'requestId', 'method', 'status', 'turnId')}
                for row in engine_snapshot.get('approvals', [])[-8:]
            ]
            evidence['engineProtocolEvents'] = engine_snapshot.get('observedProtocolEvents', [])[-24:]
            evidence['driverOperations'] = engine_snapshot.get('driverOperations', [])
            evidence['reconciliationStageTrace'] = engine_snapshot.get('reconciliationStageTrace', [])[-32:]
            evidence['rpcTrace'] = engine_snapshot.get('rpcTrace', [])[-16:]
        except Exception as error:
            evidence['engineSnapshotError'] = type(error).__name__
        try:
            native_snapshot = await asyncio.wait_for(peer.call('thread/read', {'threadId': thread}), 5)
            evidence['nativeTurnStatus'] = native_snapshot.get('thread', {}).get('status', {}).get('type')
        except Exception as error:
            evidence['nativeThreadReadError'] = type(error).__name__
        evidence['observedTurns'] = [
            {'method': event.get('method'), 'turnId': event.get('params', {}).get('turn', {}).get('id')}
            for event in peer.events if event.get('method') in ('turn/started', 'turn/completed')
        ][-8:]
        evidence['providerTrace'] = provider_trace[-8:]
        evidence['queuedProviderActionTypes'] = [action for action, _ in actions[-8:]]
        return evidence

    async def wait_records(count):
        while len(records) < count:
            await asyncio.sleep(.02)

    def config_diff(stage, before, after):
        # Both inputs belong to this fresh synthetic profile; never read a user config.
        lines = list(itertools.islice(difflib.unified_diff(before.splitlines(keepends=True),
            after.splitlines(keepends=True), fromfile='synthetic-before/config.toml',
            tofile='synthetic-after/config.toml'), 81))
        difference = ''.join(lines[:80])
        report.setdefault('configDiagnostics', []).append({'stage': stage, 'changed': before != after,
            'beforeSha256': hashlib.sha256(before.encode()).hexdigest(),
            'afterSha256': hashlib.sha256(after.encode()).hexdigest(),
            'unifiedDiff': difference[:8192], 'truncated': len(lines) > 80 or len(difference) > 8192})

    async def ordinary_linux_cli(env, workspace, thread, peer, engine, pid, expected_config):
        # A real controlling PTY exercises normal interactive daemon discovery.
        # Only fixed terminal queries are answered; no --remote, -c or Rele shim.
        import errno
        import fcntl
        import pty
        import struct
        import termios

        config_path = Path(env['CODEX_HOME']) / 'config.toml'
        before_config = config_path.read_text(encoding='utf-8')
        if before_config != expected_config:
            config_diff('before-ordinary-linux-cli', expected_config, before_config)
        assert before_config == expected_config, 'Fixture config changed before ordinary native CLI launch'
        before = await engine.command('snapshot')
        before_records = len(records)
        previous_turns = {event['params']['turn']['id'] for event in peer.events if event.get('method') == 'turn/started'}
        marker = 'ordinary-linux-cli-shared-request'
        command = [str(args.cli), '--no-alt-screen', 'resume', thread, marker]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        terminal = os.fdopen(master, 'rb', buffering=0)
        reader = asyncio.StreamReader()
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), terminal)
        process = pump = None
        output = bytearray()
        queries = {b'\x1b[6n': b'\x1b[1;1R', b'\x1b[?u': b'\x1b[?0u\x1b[?1;2c', b'\x1b[c': b'\x1b[?1;2c',
                   b'\x1b]10;?': b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\', b'\x1b]11;?': b'\x1b]11;rgb:0000/0000/0000\x1b\\'}

        async def read_terminal():
            try:
                while chunk := await reader.read(65536):
                    output.extend(chunk)
                    del output[:-65536]
                    for query, reply in list(queries.items()):
                        if query in output:
                            os.write(master, reply)
                            del queries[query]
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

        try:
            process = await asyncio.create_subprocess_exec(*command, env={**env, 'TERM': 'xterm-256color'}, cwd=workspace,
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
            processes.append(process)
            os.close(slave); slave = None
            pump = asyncio.create_task(read_terminal())
            try:
                await asyncio.wait_for(wait_records(before_records + 1), 45)
            except TimeoutError:
                raise RuntimeError('Ordinary CLI did not submit its initial prompt: ' + output.decode(errors='replace')[-2000:])
            started = await peer.wait(lambda event: event.get('method') == 'turn/started'
                and event['params'].get('threadId') == thread and event['params']['turn']['id'] not in previous_turns)
            turn = started['params']['turn']['id']
            await peer.completed(turn)
            assert len(records) == before_records + 1
            assert all(text in json.dumps(records[-1]) for text in
                ('rele-first-desktop-prior-context', 'rele-first-slack-request', 'shared-passive-agent-context', marker))
            after = await engine.command('wait', turnId=turn)
            assert after['threadId'] == thread and after['runtimeProcessId'] == pid
            assert all(any(event == {'method': method, 'threadId': thread, 'turnId': turn} for event in after['observedTurns'])
                       for method in ('turn/started', 'turn/completed'))
            assert after['requests'] == before['requests'] and after['deliveries'] == before['deliveries']
            os.write(master, b'\x04')
            await asyncio.wait_for(process.wait(), 10)
            assert process.returncode == 0, 'Ordinary CLI did not close cleanly'
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            config_diff('ordinary-linux-cli-exit', before_config, config_path.read_text(encoding='utf-8'))
            report['ordinaryLinuxCli'] = {'originalThreadId': thread, 'turnId': turn, 'backendProcessId': pid,
                'arguments': command[1:], 'usedPty': True, 'usedRemoteOverride': False, 'usedReleWrapper': False}
            report['checks']['ordinary_linux_cli_resume_shares_original_thread_and_backend_pid'] = True
            report['checks']['ordinary_linux_cli_prompt_retains_full_shared_context'] = True
            report['checks']['ordinary_linux_cli_turn_seen_by_rele_and_subscriber'] = True
            report['checks']['ordinary_linux_cli_turn_creates_no_external_request_or_delivery'] = True
        finally:
            if slave is not None:
                os.close(slave)
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill(); await process.wait()
            transport.close()
            if pump:
                await asyncio.gather(pump, return_exceptions=True)

    async def scenario(order):
        shell_deadline = None
        # Keep fixture paths below the native Windows AF_UNIX SUN_LEN limit.
        directory = root / {'rele-first': 'r', 'desktop-first': 'f', 'desktop-bundle': 'd'}[order]
        home, workspace = directory / 'c', directory / 'w'
        home.mkdir(parents=True)
        workspace.mkdir()
        scenario_config = config
        if sys.platform == 'linux':
            scenario_config = 'suppress_unstable_features_warning=true\n' + config + f'''
[analytics]
enabled=false
[tui]
disable_paste_burst=true
# Native TUI writes this accessibility marker on first run; seed only the fixture.
screen_reader_detection_done=true
[projects.{json.dumps(str(workspace))}]
trust_level="trusted"
'''
        if args.desktop_bundle:
            # Desktop's enabled-only MCP overrides need a complete, inert stdio definition.
            scenario_config += f'''
[mcp_servers.codex_app]
command={json.dumps(str(home / 'disabled-mcp-fixture'))}
enabled=false
[mcp_servers.code-review]
command={json.dumps(str(home / 'disabled-mcp-fixture'))}
enabled=false
'''
        (home / 'config.toml').write_text(scenario_config, encoding='utf-8')
        env = {**base_env, 'CODEX_HOME': str(home), 'RELE_DATA_DIR': str(directory / 'rele')}
        # Disable the optional native updater before any start: package installation
        # must come entirely from the validated local npm or real Desktop bytes.
        settings = home / 'app-server-daemon'
        if os.name == 'nt':
            await prepare_windows(env, directory)
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
            if args.desktop_bundle:
                # Seed ordinary history through the actual flat Desktop backend before
                # Rele can prepare a native package or start its shared singleton.
                peer = await desktop(env, 'actual_desktop_private_seed', private=True)
                report['actualDesktopBackendExecuted'] = True
                thread = (await peer.call('thread/start', {'cwd': str(workspace)}))['thread']['id']
                await peer.call('thread/name/set', {'threadId': thread, 'name': 'Original signed Desktop thread'})
                prior = (await peer.call('turn/start', {'threadId': thread,
                    'input': [{'type': 'text', 'text': f'{order}-desktop-prior-context'}]}))['turn']['id']
                await peer.completed(prior)
                private_pid = (await peer.call('server/diagnostics'))['process']['id']
                # Seed and close this fixture's private server; no adapter or private-owner takeover.
                await peer.close(); peer = None
                assert not (home / 'packages').exists()
                assert not (home / 'app-server-control/app-server-control.sock').exists()
                assert not (directory / 'rele/codex-desktop-packages').exists()
                assert not list(install.rglob('codex-package.json'))
                report['checks']['original_desktop_thread_history_precede_native_bootstrap'] = True
                engine, ready = await driver(env, workspace, thread=thread)
                pid = ready['runtimeProcessId']
                assert ready['configuredExecutable'] == (str(args.cli) if args.installed_desktop else 'codex') and ready['catalogValidated']
                assert ready['threadId'] == thread and pid != private_pid
                report['desktopBootstrap'] = {'originalThreadId': thread, 'privateProcessId': private_pid,
                    'nativeProcessId': pid, 'configuredExecutable': ready['configuredExecutable'],
                    'codexHome': ready['runtime']['codexHome'], 'automaticDiscovery': not args.installed_desktop}
                assert native_executables[env['CODEX_HOME']] == Path(ready['status']['executable']).resolve()
                peer = await desktop(env, 'actual_desktop_direct_ws_peer')
                await peer.call('thread/resume', {'threadId': thread, 'excludeTurns': True})
                report['checks']['explicit_installed_desktop_backend_same_thread_profile' if args.installed_desktop
                    else 'production_auto_discovery_bootstraps_desktop_only_same_thread_profile'] = True
            elif order == 'rele-first':
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
            if os.name == 'nt' and order in ('rele-first', 'desktop-bundle'):
                assert ready.get('preparedRuntime') and native_executables[env['CODEX_HOME']] != args.cli.resolve(), 'Cold Windows bootstrap did not use the verified private native package'
            report['checks'][f'{order}_same_original_id_profile_pid'] = True
            if order == 'rele-first':
                wrong_home = directory / 'other-profile'
                wrong_home.mkdir()
                before_requests = len(records)
                before_threads = await peer.call('thread/list', {})
                await driver({**env, 'CODEX_HOME': str(wrong_home), 'RELE_DATA_DIR': str(directory / 'other-rele')},
                    workspace, profile_socket=windows_fixtures[env['CODEX_HOME']]['endpoint'] if os.name == 'nt' else home / 'app-server-control/app-server-control.sock')
                assert not (wrong_home / 'app-server-control/app-server-control.sock').exists()
                assert len(records) == before_requests and (await peer.call('thread/list', {})) == before_threads
                assert (await peer.call('server/diagnostics'))['process']['id'] == pid
                report['checks']['native_initialize_wrong_profile_rejected_before_thread_or_model_work'] = True
            first, again = await native(env, 'start'), await native(env, 'start')
            assert first['status'] == again['status'] == 'alreadyRunning'
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            if os.name == 'nt':
                assert first['processId'] == again['processId'] == pid
                assert first['endpoint'] == again['endpoint']
                assert not (home / 'packages').exists() and not (home / 'app-server-control/app-server-control.sock').exists()
                report['checks'][f'{order}_direct_owner_idempotent_original_backend_without_native_daemon_or_adapter'] = True
            else:
                assert Path(first['socketPath']).resolve() == (home / 'app-server-control/app-server-control.sock').resolve()
                installed = Path(first['managedCodexPath']).parent.parent / 'codex-package.json'
                assert installed.is_file()
                assert installed.read_bytes() == (args.package / 'codex-package.json').read_bytes()
                assert not (settings / 'daemon-updater.pid').exists()
                report['checks'][f'{order}_native_start_idempotent_local_package_only'] = True
            before = len(records)
            if order == 'rele-first' and not args.desktop_bundle:
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
            assert all(marker in json.dumps(records[-1]) for marker in
                       (f'{order}-desktop-prior-context', 'shared-passive-agent-context', f'{order}-slack-request'))
            report['checks'][f'{order}_slack_full_context_and_exact_origin'] = True
            if sys.platform == 'linux' and order == 'rele-first':
                await ordinary_linux_cli(env, workspace, thread, peer, engine, pid, scenario_config)
            if order == 'desktop-first':
                await engine.close()
                engine = None
                assert (await peer.call('server/diagnostics'))['process']['id'] == pid
                report['checks']['desktop_first_rele_close_preserves_native_owner'] = True
                return
            # A real Rele request is active while its client/engine process is closed.
            hold = asyncio.Event(); holds.append(hold); actions.append(('hold', hold))
            before = len(records)
            started_before = {event.get('params', {}).get('turn', {}).get('id') for event in peer.events
                              if event.get('method') == 'turn/started'}
            try:
                await engine.command('ingest', platform='telegram', eventId='held-telegram', text='held-original-request', loseAck=True)
                turn_started = await peer.wait(lambda event: event.get('method') == 'turn/started'
                    and event.get('params', {}).get('threadId') == thread
                    and event.get('params', {}).get('turn', {}).get('id') not in started_before,
                    timeout=ENGINE_READ_TIMEOUT_SECONDS)
                accepted = await engine.command('snapshot')
                assert accepted['droppedQueueAcks'] == 1, 'The synthetic queue ACK was not withheld'
            except (TimeoutError, RuntimeError):
                report['heldRequestTimeout'] = await held_request_evidence(engine, peer, thread)
                raise
            request = next(row for row in accepted['requests'] if row['eventId'] == 'held-telegram')
            assert str(uuid.UUID(request['id'])) == request['id']
            turn_id = turn_started['params']['turn']['id']
            await engine.close(); engine = None
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            assert (await peer.call('thread/read', {'threadId': thread}))['thread']['status']['type'] != 'idle'
            engine, restarted = await driver(env, workspace, thread=thread)
            assert restarted['runtimeProcessId'] == pid
            hold.set()
            completed = await engine.command('wait')
            recovered = next(row for row in completed['requests'] if row['id'] == request['id'])
            assert recovered['status'] == 'completed' and recovered['origin'] == request['origin'] and recovered['turnId'] == turn_id
            assert len(records) == before + 1, 'Rele restart replayed an accepted native request'
            assert any(row['requestId'] == request['id'] and row['origin']['platform'] == 'telegram' and row['status'] == 'sent'
                       for row in completed['deliveries'])
            report['checks']['rele_restart_after_lost_ack_preserves_active_native_turn_uuid_without_resend'] = True
            if args.desktop_bundle:
                report['desktopBootstrap']['recoveredRequestId'] = request['id']
                report['desktopBootstrap']['recoveredTurnId'] = turn_id
                report['desktopBootstrap']['recoveryNativeProcessId'] = restarted['runtimeProcessId']
            # An origin-owned approval is resolved by the real Engine; Desktop sees it.
            actions.append(('approval', None))
            await engine.command('ingest', platform='telegram', eventId='approval', text='shared-approval-request')
            try:
                pending = await engine.command('wait', status='waiting_approval')
            except (TimeoutError, RuntimeError):
                report['approvalWaitFailure'] = await held_request_evidence(engine, peer, thread)
                raise
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
            question_record_start = len(records)
            question_turn = (await peer.call('turn/start', {'threadId': thread,
                'collaborationMode': {'mode': 'plan', 'settings': {'model': 'mock-model',
                    'reasoning_effort': None, 'developer_instructions': None}},
                'input': [{'type': 'text', 'text': 'shared-native-question'}]}))['turn']['id']
            try:
                question = await peer.wait(lambda event: event.get('method') == 'item/tool/requestUserInput'
                                          and event['params'].get('turnId') == question_turn)
            except TimeoutError:
                question_records = records[question_record_start:]
                report['questionDiagnostics'] = {
                    'advertisedTools': [{'type': tool.get('type'), 'name': tool.get('name'),
                        'parameterKeys': sorted((tool.get('parameters') or {}).get('properties', {}))}
                        for tool in (question_records[0].get('tools', []) if question_records else [])
                        if tool.get('name') in ('exec', 'request_user_input')],
                    'toolOutputs': [{'type': item['type'], 'callId': item.get('call_id'),
                        'output': str(item.get('output', ''))[:2048]}
                        for record in question_records for item in record.get('input', [])
                        if item.get('type') in ('function_call_output', 'custom_tool_call_output')
                        and item.get('call_id') == f'call-{question_record_start + 1}'][:4],
                    'events': [{'method': event.get('method'), 'itemType': (event['params'].get('item') or {}).get('type'),
                        'itemName': (event['params'].get('item') or {}).get('name'),
                        'status': (event['params'].get('turn') or {}).get('status'),
                        'errorMessage': str(event['params']['error'].get('message', '') if isinstance(event['params'].get('error'), dict) else '')[:512]}
                        for event in peer.events if event.get('params', {}).get('turnId') == question_turn
                        or (event.get('params', {}).get('turn') or {}).get('id') == question_turn][-30:]}
                raise
            observer = await desktop(env, 'desktop_question_peer', plugin_helpers=True)
            await observer.call('thread/resume', {'threadId': thread, 'excludeTurns': True})
            assert (await observer.call('server/diagnostics'))['process']['id'] == pid
            if os.name == 'nt':
                report['checks']['direct_ws_peers_attach_same_native_pid_without_desktop_adapter'] = True
            else:
                assert len(report['desktopStartupArgv']) == 2
                assert {flags[-1].rsplit('=', 1)[1] for flags in report['desktopStartupArgv']} == {'true', 'false'}
                report['checks']['desktop_actual_global_config_argv_and_both_plugin_hint_variants_attach_same_native_pid'] = True
            replay = await observer.wait(lambda event: event.get('method') == 'item/tool/requestUserInput'
                                        and event['params'].get('turnId') == question_turn)
            assert replay['id'] == question['id'] and replay['params'] == question['params']
            await observer.send({'id': replay['id'], 'result': {'answers': {'continue': {'answers': ['Yes']}}}})
            await peer.completed(question_turn)
            assert 'Yes' in json.dumps(records[-1])
            report['checks']['desktop_question_late_replay_and_peer_answer_share_owner'] = True
            # The command is bounded and writes only inside this disposable workspace.
            ready_file, late_file = workspace / 'cancel-ready.json', workspace / 'cancel-late.txt'
            command_file = workspace / 'cancel-child.cjs'
            # Keep the marker timer beyond the bounded Windows cancellation proof window.
            shell_delay = ENGINE_CANCEL_READ_TIMEOUT_SECONDS + 120 if os.name == 'nt' else 60
            # PowerShell 5 strips embedded JS quotes from native -e arguments.
            command_file.write_text(f'const f=require("node:fs");f.writeFileSync(process.argv[2],JSON.stringify({{pid:process.pid}}));setTimeout(()=>f.writeFileSync(process.argv[3],"not-stopped"),{shell_delay * 1000});', encoding='utf-8')
            command_args = [str(Path(NODE).resolve(strict=True)), str(command_file), str(ready_file), str(late_file)]
            shell_command = ('& ' + ' '.join("'" + value.replace("'", "''") + "'" for value in command_args)
                             if os.name == 'nt' else shlex.join(command_args))
            hold_cancel = asyncio.Event(); holds.append(hold_cancel)
            actions.extend([('shell', {'cmd': shell_command, 'yield_time_ms': 1000, 'max_output_tokens': 100,
                'sandbox_permissions': 'require_escalated', 'justification': 'Run only the bounded disposable shell cancellation fixture.'}),
                ('hold', hold_cancel)])
            before = len(records)
            await engine.command('ingest', platform='telegram', eventId='cancel', text='shared-cancel-request')
            deadline = asyncio.get_running_loop().time() + ENGINE_SHARED_SHELL_START_TIMEOUT_SECONDS
            while True:
                pending = await engine.command('snapshot')
                shell_approvals = [item for item in pending['approvals'] if item['status'] == 'pending']
                if shell_approvals or ready_file.is_file():
                    break
                if asyncio.get_running_loop().time() >= deadline:
                    report['cancellationRequestTimeout'] = await held_request_evidence(engine, peer, thread)
                    report['cancellationRequestTimeout']['readyFileExists'] = ready_file.is_file()
                    raise AssertionError('Shell neither started nor requested approval')
                await asyncio.sleep(.05)
            assert len(shell_approvals) <= 1 and all(item['method'] == 'item/commandExecution/requestApproval' and item['requestId'] == next(row['id'] for row in pending['requests'] if row['eventId'] == 'cancel') for item in shell_approvals), 'Unexpected shell approval'
            if shell_approvals:
                await engine.command('answer', approvalId=shell_approvals[0]['id'], decision='accept')
            await asyncio.wait_for(wait_records(before + 2), 25)
            assert ready_file.is_file(), 'Bounded shell child did not start'
            shell_deadline = asyncio.get_running_loop().time() + shell_delay + 1
            if args.expected_version == '0.166.0-alpha.6':
                assert any(item.get('type') == 'custom_tool_call_output' and item.get('call_id') == f'call-{before + 1}' for item in records[before + 1].get('input', [])), 'Missing actual custom exec result'
            child_pid = json.loads(ready_file.read_text())['pid']
            running = await engine.command('wait', status='running')
            cancel = next(row for row in running['requests'] if row['eventId'] == 'cancel')
            command_item = await peer.wait(lambda event: event.get('method') == 'item/started'
                and event['params'].get('turnId') == cancel['turnId']
                and event['params'].get('item', {}).get('type') == 'commandExecution')
            item_id = command_item['params']['item']['id']
            terminal_deadline = asyncio.get_running_loop().time() + 2
            while True:
                terminal_page = await peer.call('thread/backgroundTerminals/list', {'threadId': thread, 'limit': 100})
                assert not terminal_page.get('nextCursor'), 'Unexpected terminal pagination in the disposable fixture'
                terminals = terminal_page['data']
                matching_terminals = [item for item in terminals if item['itemId'] == item_id]
                if matching_terminals:
                    break
                assert asyncio.get_running_loop().time() < terminal_deadline, 'Started command did not appear as a background terminal'
                await asyncio.sleep(.05)
            assert len(matching_terminals) == 1
            assert (await engine.command('snapshot', processId=child_pid))['probeProcessAlive']
            queued = await engine.command('ingest', platform='slack', eventId='after-shell-cancel', text='shared-after-shell-cancel')
            following = next(row for row in queued['requests'] if row['eventId'] == 'after-shell-cancel')
            assert following['status'] == 'queued'
            cancelled = await engine.command('cancel', requestId=cancel['id'], processId=child_pid)
            witnesses = cancelled['cancellationInterruptWitnesses']
            report.setdefault('cancellationInterruptWitnesses', []).extend({'scenario': order, **item} for item in witnesses)
            assert len(witnesses) == 1 and witnesses[0] == {'threadId': thread, 'turnId': cancel['turnId'],
                'processId': child_pid, 'processAlive': True, 'markerExists': False}, 'Native interrupt was not dispatched against the live fixture child before its delayed marker'
            assert not cancelled['probeProcessAlive'], 'Engine cancelled the model but left its shell child alive'
            assert asyncio.get_running_loop().time() < shell_deadline, 'Windows cancellation exceeded the delayed-marker proof window'
            assert not late_file.exists(), 'Cancelled shell wrote its delayed marker'
            aborted = await peer.completed(cancel['turnId'])
            assert aborted['params']['turn']['status'] == 'interrupted'
            hold_cancel.set()
            try:
                completed = await engine.command('wait')
            except RuntimeError:
                report['afterShellCancelWaitFailure'] = await held_request_evidence(engine, peer, thread)
                raise
            following_rows = [row for row in completed['requests'] if row['id'] == following['id']]
            assert len(following_rows) == 1 and following_rows[0]['status'] == 'completed'
            assert following_rows[0]['origin'] == following['origin']
            checks = [item for item in completed['cancellationProcessChecks'] if item['turnId'] == following_rows[0]['turnId']]
            assert len(checks) == 1 and checks[0]['processAlive'] is False, 'Next turn started before shell cleanup'
            assert len([item for item in completed['deliveries'] if item['requestId'] == following['id']
                        and item['origin'] == following['origin'] and item['status'] == 'sent']) == 1
            assert (await peer.call('server/diagnostics'))['process']['id'] == pid
            terminal_page = await peer.call('thread/backgroundTerminals/list', {'threadId': thread, 'limit': 100})
            assert not terminal_page.get('nextCursor'), 'Unexpected terminal pagination in the disposable fixture'
            terminals = terminal_page['data']
            assert not any(item['itemId'] == item_id for item in terminals)
            report['checks']['origin_engine_cancels_exact_native_turn_seen_by_desktop'] = True
            report['checks']['engine_shell_stop_cleans_owned_process_before_next_origin_turn_without_backend_restart'] = True
            if args.expected_version == '0.166.0-alpha.6':
                assert terminal_page['data'] == [] and terminal_page['nextCursor'] is None, 'Native background terminals are not confirmed empty through EOF'
                native_queue = await peer.call('thread/queue/list', {'threadId': thread, 'limit': 100})
                assert native_queue['data'] == [] and native_queue['nextCursor'] is None, 'Native cancellation queue is not confirmed empty through EOF'
                command_completed = await peer.wait(lambda event: event.get('method') == 'item/completed'
                    and event['params'].get('threadId') == thread and event['params'].get('turnId') == cancel['turnId']
                    and event['params'].get('item', {}).get('type') == 'commandExecution'
                    and event['params']['item'].get('id') == item_id)
                started_item, finished_item = command_item['params']['item'], command_completed['params']['item']
                assert command_item['params']['threadId'] == thread and isinstance(started_item.get('command'), str) and started_item['command'], 'Missing canonical started command'
                assert finished_item.get('command') == started_item['command'] and finished_item.get('cwd') == started_item['cwd'] and finished_item.get('status') in ('completed', 'failed'), 'Canonical command completion changed'
                cleanup = completed['cancelCleanups'][cancel['id']]
                assert cleanup['done'] is True and cleanup['turnId'] == cancel['turnId'] and cleanup['interruptAttempted'] is True, 'Engine cancel cleanup is not confirmed done for the original turn'
                cancelled_rows = [row for row in completed['requests'] if row['id'] == cancel['id']]
                assert len(cancelled_rows) == 1 and cancelled_rows[0]['status'] == 'interrupted' and cancelled_rows[0]['turnId'] == cancel['turnId'] and cancelled_rows[0].get('queuedSubmissionId') == cancel.get('queuedSubmissionId') and cancelled_rows[0]['origin'] == cancel['origin'], 'Cancelled request identity or terminal receipt changed'
                report['checks']['custom_exec_code_mode_host_starts_and_cancels_owned_shell'] = True
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
            ingressed = await engine.command('ingest', platform='telegram', eventId='after-native-restart', text='after-native-restart-request')
            continued = next(row for row in ingressed['requests'] if row['eventId'] == 'after-native-restart')
            assert str(uuid.UUID(continued['id'])) == continued['id']
            completed = await engine.command('wait')
            recovered = [row for row in completed['requests'] if row['eventId'] == 'after-native-restart']
            assert len(recovered) == 1 and recovered[0]['id'] == continued['id']
            assert recovered[0]['status'] == 'completed' and recovered[0]['origin'] == continued['origin']
            assert len(records) == before + 1, 'Automatic continuation duplicated the accepted request'
            turns = (await peer.call('thread/turns/list', {'threadId': thread, 'limit': 100,
                     'itemsView': 'full', 'sortDirection': 'desc'}))['data']
            own_turns = [turn for turn in turns if any(item.get('type') == 'userMessage'
                         and item.get('clientId') == continued['id'] for item in turn['items'])]
            assert len(own_turns) == 1 and own_turns[0]['id'] == recovered[0]['turnId']
            assert next(row for row in completed['requests'] if row['id'] == cancel['id'])['status'] == 'interrupted'
            report['checks']['interrupted_native_queue_automatic_continuation_without_resend'] = True
            assert all(marker in json.dumps(records[before]) for marker in
                       (f'{order}-desktop-prior-context', f'{order}-slack-request', 'held-original-request'))
            report['checks']['native_stop_start_restart_restores_original_id_history_and_rele_records'] = True
            if args.desktop_bundle:
                report['desktopBootstrap']['restartedNativeProcessId'] = new_pid
                report['desktopBootstrap']['preservedRequestIds'] = sorted(preserved)
            final_config = (home / 'config.toml').read_text(encoding='utf-8')
            if final_config != scenario_config:
                config_diff(f'{order}-scenario-final', scenario_config, final_config)
            assert final_config == scenario_config, 'Isolated fixture config changed; see bounded configDiagnostics'
            report['checks']['isolated_native_user_config_unchanged'] = True
        finally:
            for event in holds:
                event.set()
            primary_error = sys.exc_info()[1]
            cleanup_errors = []
            for operation, client in (('engine.close', engine), ('observer.close', observer), ('peer.close', peer)):
                if client:
                    process = getattr(client, 'process', None)
                    resource = 'engine-driver-process' if isinstance(client, EngineDriver) else 'desktop-shim-process' if process else 'direct-websocket'
                    await record_cleanup_error(cleanup_errors, operation, resource, client.close,
                        process.pid if process else None, locals().get('pid'))
            async def stop_native():
                stopped = await native(env, 'stop')
                assert stopped['status'] in ('stopped', 'notRunning')
            await record_cleanup_error(cleanup_errors, 'native.stop', 'native-owner' if os.name == 'nt' else 'native-daemon', stop_native,
                owner_pid=locals().get('pid'))
            if cleanup_errors:
                args.retain_fixture = True
                report['retainedFixture'] = str(root)
                report.setdefault('cleanupErrors', []).extend(cleanup_errors)
                failure = cleanup_failure_message(primary_error, cleanup_errors)
                if failure:
                    raise RuntimeError(failure)

    try:
        if args.desktop_bundle:
            await scenario('desktop-bundle')
        else:
            await scenario('rele-first')
            await scenario('desktop-first')
        report['syntheticProviderRequests'] = len(records)
        assert all(report['checks'].values())
        report['result'] = 'passed'
    except BaseException as error:
        report['result'] = 'failed'
        report['failureType'] = safe_error_type(error)
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
        print(json.dumps(public_console_report(report), indent=2))


if __name__ == '__main__':
    args = arguments()
    fixture_parent = os.environ.get('USERPROFILE') if os.name == 'nt' else os.environ.get('RUNNER_TEMP')
    if not fixture_parent or not Path(fixture_parent).is_dir():
        raise SystemExit('Isolated fixture parent is unavailable.')
    if os.name == 'nt':
        temp_parent = Path(os.environ['RUNNER_TEMP']).resolve()
        profile_parent = Path(fixture_parent).resolve()
        if profile_parent == temp_parent or temp_parent in profile_parent.parents:
            raise SystemExit('Windows Codex fixtures must be created outside RUNNER_TEMP.')
    directory = Path(tempfile.mkdtemp(prefix='rs-', dir=fixture_parent))
    try:
        try:
            asyncio.run(gate(args, directory))
        except Exception as error:
            print(f'Shared protocol gate failed ({safe_error_type(error)}).', file=sys.stderr)
            raise SystemExit(1) from None
    finally:
        # A failed owner/receipt guard means a scheduled Task may still reference
        # these private files. Preserve them for exact-identity cleanup by the caller.
        if not args.retain_fixture:
            shutil.rmtree(directory)

import ast
import asyncio
import json
import pathlib
import re
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = ROOT / 'scripts/shared-protocol-probe.py'
HELPERS = {'safe_error_type', 'safe_failure_code', 'safe_engine_driver_stage', 'safe_failure_location', 'public_failure_location', 'record_cleanup_error', 'cleanup_failure_message', 'public_console_report', 'EngineDriver'}


def load_helpers(test):
    module = ast.parse(PROBE.read_text(encoding='utf-8'))
    functions = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in HELPERS]
    missing = HELPERS - {function.name for function in functions}
    test.assertEqual(missing, set(), f'missing testable cleanup diagnostics: {sorted(missing)}')
    namespace = {'Path': pathlib.Path, '__file__': str(PROBE), 're': re, 'json': json, 'time': time, 'asyncio': asyncio, 'ENGINE_READ_TIMEOUT_SECONDS': 1}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(PROBE), 'exec'), namespace)
    return namespace


class CleanupDiagnostics(unittest.TestCase):
    def test_failure_location_reports_only_probe_function_and_line(self):
        helpers = load_helpers(self)

        class Stdin:
            def write(self, value):
                return None

            async def drain(self):
                return None

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"stopped":true}\n')
                self.stdin = Stdin()
                self.returncode = None

        async def close():
            try:
                await helpers['EngineDriver'](Process()).close()
            except (RuntimeError, AssertionError) as error:
                location = helpers['safe_failure_location'](error)
            else:
                self.fail('EngineDriver.close must reject the incomplete close acknowledgement')
            self.assertEqual(location['function'], 'close')
            self.assertIsInstance(location['line'], int)
            self.assertGreater(location['line'], 0)
            errors = []
            await helpers['record_cleanup_error'](
                errors, 'engine.close', 'engine-driver-process', helpers['EngineDriver'](Process()).close, 101, 202)
            report = helpers['public_console_report']({
                'result': 'failed',
                'failureLocation': {**location, 'path': 'C:\\private\\runner'},
                'cleanupErrors': errors,
                'exception': 'C:\\private\\runner and synthetic conversation',
            })
            self.assertEqual(report['failureLocation'], location)
            self.assertEqual(report['cleanupErrors'][0]['failureLocation']['function'], 'close')
            self.assertIsInstance(report['cleanupErrors'][0]['failureLocation']['line'], int)
            self.assertNotIn('private', json.dumps(report))
            self.assertNotIn('synthetic conversation', json.dumps(report))
            self.assertNotIn(str(PROBE.parent), json.dumps(report))

        asyncio.run(close())

    def test_engine_eof_preserves_only_the_driver_exit_code(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_eof()
                self.returncode = 23

        async def read_eof():
            driver = helpers['EngineDriver'](Process())
            with self.assertRaisesRegex(RuntimeError, '^Shared Engine driver exited before responding$') as raised:
                await driver.read()
            self.assertEqual(getattr(raised.exception, 'engine_driver_exit_code', None), 23)

        asyncio.run(read_eof())

    def test_engine_eof_waits_for_the_process_exit_code(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_eof()
                self.returncode = None

            async def wait(self):
                await asyncio.sleep(0)
                self.returncode = 23
                return self.returncode

        async def read_eof():
            driver = helpers['EngineDriver'](Process())
            with self.assertRaisesRegex(RuntimeError, '^Shared Engine driver exited before responding$') as raised:
                await driver.read()
            self.assertEqual(getattr(raised.exception, 'engine_driver_exit_code', None), 23)

        asyncio.run(read_eof())

    def test_engine_eof_preserves_allowlisted_startup_stage(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"probeStage":"shared-codex-resolved"}\n')
                self.stdout.feed_eof()
                self.returncode = 0

        async def read_eof():
            driver = helpers['EngineDriver'](Process())
            with self.assertRaisesRegex(RuntimeError, '^Shared Engine driver exited before responding$') as raised:
                await driver.read()
            self.assertEqual(getattr(raised.exception, 'engine_driver_stage', None), 'shared-codex-resolved')

        asyncio.run(read_eof())

    def test_ready_response_clears_startup_stage(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"probeStage":"ready"}\n{"ready":true}\n')
                self.returncode = None

        async def read_ready():
            driver = helpers['EngineDriver'](Process())
            self.assertEqual(await driver.read(), {'ready': True})
            self.assertIsNone(driver.startup_stage)

        asyncio.run(read_ready())

    def test_engine_driver_consumes_shared_resolver_completion_stage(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"probeStage":"shared-codex-resolved"}\n{"ready":true}\n')
                self.returncode = None

        async def read_ready():
            driver = helpers['EngineDriver'](Process())
            self.assertEqual(await driver.read(), {'ready': True})
            self.assertEqual(driver.startup_stage, 'shared-codex-resolved')

        asyncio.run(read_ready())

    def test_failure_code_only_maps_known_static_native_failures(self):
        helpers = load_helpers(self)
        self.assertEqual(
            helpers['safe_failure_code'](AssertionError('Native background terminals are not confirmed empty through EOF')),
            'native-background-terminals-not-empty',
        )
        self.assertEqual(
            helpers['safe_failure_code'](AssertionError('Native cancellation queue is not confirmed empty through EOF')),
            'native-cancellation-queue-not-empty',
        )
        self.assertEqual(
            helpers['safe_failure_code'](RuntimeError('Shared Engine driver exited before responding')),
            'engine-driver-exited-before-response',
        )
        self.assertIsNone(helpers['safe_failure_code'](AssertionError('private path and conversation text')))
        self.assertIsNone(helpers['safe_failure_code'](RuntimeError('private path and conversation text')))

    def test_engine_driver_stage_only_maps_known_startup_stages(self):
        helpers = load_helpers(self)
        self.assertEqual(helpers['safe_engine_driver_stage']('native-diagnostics'), 'native-diagnostics')
        self.assertEqual(helpers['safe_engine_driver_stage']('shared-codex-resolution'), 'shared-codex-resolution')
        self.assertEqual(helpers['safe_engine_driver_stage']('shared-codex-resolved'), 'shared-codex-resolved')
        self.assertIsNone(helpers['safe_engine_driver_stage']('codex-websocket-open'))
        self.assertEqual(helpers['safe_engine_driver_stage']('windows-owner-start'), 'windows-owner-start')
        self.assertEqual(helpers['safe_engine_driver_stage']('windows-socket-verification'), 'windows-socket-verification')
        self.assertEqual(helpers['safe_engine_driver_stage']('engine-close-request'), 'engine-close-request')
        self.assertEqual(helpers['safe_engine_driver_stage']('engine-close-ack'), 'engine-close-ack')
        self.assertIsNone(helpers['safe_engine_driver_stage']('C:\\private\\runner'))

    def test_successful_cleanup_leaves_no_error(self):
        helpers = load_helpers(self)
        errors = []

        async def close():
            return None

        asyncio.run(helpers['record_cleanup_error'](errors, 'engine.close', 'engine-driver-process', close, 101, 202))
        self.assertEqual(errors, [])
        self.assertIsNone(helpers['cleanup_failure_message'](None, errors))
        self.assertIsNone(helpers['cleanup_failure_message'](TimeoutError('primary failure'), errors))

    def test_failed_cleanup_records_bounded_category_and_process_metadata(self):
        helpers = load_helpers(self)
        errors = []

        async def close():
            raise TimeoutError('C:\\private\\runner path and synthetic conversation')

        asyncio.run(helpers['record_cleanup_error'](errors, 'engine.close', 'engine-driver-process', close, 101, 202))
        self.assertEqual(len(errors), 1)
        error = errors[0]
        self.assertEqual(error['operation'], 'engine.close')
        self.assertEqual(error['errorType'], 'TimeoutError')
        self.assertEqual(error['resource'], 'engine-driver-process')
        self.assertEqual((error['processPid'], error['ownerPid']), (101, 202))
        self.assertIsInstance(error['elapsedMs'], int)
        self.assertGreaterEqual(error['elapsedMs'], 0)
        self.assertNotIn('private', json.dumps(errors))
        self.assertNotIn('synthetic conversation', json.dumps(errors))
        self.assertEqual(helpers['cleanup_failure_message'](None, errors), 'Isolated fixture cleanup failed: engine.close')
        self.assertIsNone(helpers['cleanup_failure_message'](TimeoutError('primary failure'), errors))

    def test_engine_close_cleanup_preserves_allowlisted_driver_failure_diagnostics(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.returncode = 23

        errors = []

        async def record():
            driver = helpers['EngineDriver'](Process())
            driver.startup_stage = 'native-diagnostics'
            await helpers['record_cleanup_error'](errors, 'engine.close', 'engine-driver-process', driver.close, 101, 202)

        asyncio.run(record())
        self.assertEqual(errors[0]['errorType'], 'AssertionError')
        self.assertEqual(errors[0]['engineDriverExitCode'], 23)
        self.assertEqual(errors[0]['engineDriverStage'], 'native-diagnostics')

        report = helpers['public_console_report']({'result': 'failed', 'cleanupErrors': errors})
        self.assertEqual(report['cleanupErrors'][0]['errorType'], 'AssertionError')
        self.assertEqual(report['cleanupErrors'][0]['engineDriverExitCode'], 23)
        self.assertEqual(report['cleanupErrors'][0]['engineDriverStage'], 'native-diagnostics')
        self.assertNotIn('processPid', json.dumps(report))
        self.assertNotIn('ownerPid', json.dumps(report))

    def test_engine_close_ignores_a_late_wait_response_before_the_close_ack(self):
        helpers = load_helpers(self)

        class Stdin:
            def __init__(self):
                self.writes = []

            def write(self, value):
                self.writes.append(value)

            async def drain(self):
                return None

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(
                    b'{"action":"wait","done":true}\n'
                    b'{"action":"close","stopped":true,"runtimeProcessId":123,"backendAlive":true}\n'
                )
                self.stdin = Stdin()
                self.returncode = None

            async def wait(self):
                self.returncode = 0
                return self.returncode

        async def close():
            process = Process()
            await helpers['EngineDriver'](process).close()
            self.assertEqual(len(process.stdin.writes), 1)
            self.assertEqual(json.loads(process.stdin.writes[0]), {'action': 'close'})
            self.assertEqual(process.returncode, 0)

        asyncio.run(close())

    def test_engine_close_read_timeout_preserves_the_safe_close_stage(self):
        helpers = load_helpers(self)

        class Stdout:
            def __init__(self):
                self.first = True

            async def readline(self):
                if self.first:
                    self.first = False
                    return b'{"action":"snapshot"}\n'
                raise TimeoutError()

        class Stdin:
            def write(self, value):
                return None

            async def drain(self):
                return None

        class Process:
            def __init__(self):
                self.stdout = Stdout()
                self.stdin = Stdin()
                self.returncode = None

        async def close():
            with self.assertRaises(TimeoutError) as raised:
                await helpers['EngineDriver'](Process()).close()
            self.assertEqual(getattr(raised.exception, 'engine_driver_stage', None), 'engine-close-request')

        asyncio.run(close())

    def test_engine_close_fails_closed_without_a_close_ack(self):
        helpers = load_helpers(self)

        class Stdin:
            def write(self, value):
                return None

            async def drain(self):
                return None

        class Process:
            def __init__(self, response):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data((json.dumps(response) + '\n').encode())
                self.stdin = Stdin()
                self.returncode = None
                self.wait_calls = 0

            async def wait(self):
                self.wait_calls += 1
                self.returncode = 0
                return self.returncode

        async def close():
            for response in (
                {'stopped': True, 'backendAlive': True},
                {'action': 'close', 'stopped': False, 'backendAlive': True},
                {'action': 'close', 'stopped': True, 'backendAlive': 'unknown'},
            ):
                with self.subTest(response=response):
                    process = Process(response)
                    with self.assertRaisesRegex(RuntimeError, 'invalid close response') as raised:
                        await helpers['EngineDriver'](process).close()
                    self.assertEqual(raised.exception.engine_driver_stage, 'engine-close-request')
                    self.assertEqual(process.wait_calls, 0)

        asyncio.run(close())

    def test_engine_close_bounds_total_wait_while_stale_replies_continue(self):
        helpers = load_helpers(self)
        helpers['ENGINE_READ_TIMEOUT_SECONDS'] = .01

        class Stdout:
            def __init__(self):
                self.read_count = 0

            async def readline(self):
                self.read_count += 1
                await asyncio.sleep(.001)
                if self.read_count < 100:
                    return b'{"action":"snapshot"}\n'
                return b'{"action":"close","stopped":true,"backendAlive":true}\n'

        class Stdin:
            def write(self, _value):
                return None

            async def drain(self):
                return None

        class Process:
            def __init__(self):
                self.stdout = Stdout()
                self.stdin = Stdin()
                self.returncode = None
                self.wait_calls = 0

            async def wait(self):
                self.wait_calls += 1
                self.returncode = 0
                return self.returncode

        async def close():
            process = Process()
            with self.assertRaises(TimeoutError) as raised:
                await helpers['EngineDriver'](process).close()
            self.assertEqual(raised.exception.engine_driver_stage, 'engine-close-request')
            self.assertLess(process.stdout.read_count, 100)
            self.assertEqual(process.wait_calls, 0)

        asyncio.run(close())

    def test_console_report_exposes_only_bounded_allowlisted_fields(self):
        helpers = load_helpers(self)
        report = {
            'result': 'failed',
            'failureType': 'TimeoutError',
            'failureCode': 'native-cancellation-queue-not-empty',
            'engineDriverExitCode': 23,
            'engineDriverStage': 'native-diagnostics',
            'checks': {'first': True, 'second': False},
            'cleanupErrors': [{
                'operation': 'native.stop', 'errorType': 'TimeoutError', 'elapsedMs': 900000,
                'resource': 'native-owner', 'processPid': 101, 'ownerPid': 202,
            }],
            'retainedFixture': 'C:\\private\\runner',
            'exception': "TimeoutError('private path and conversation text')",
            'stderrTail': ['private path and conversation text'],
        }
        output = helpers['public_console_report'](report)
        self.assertEqual(output, {
            'result': 'failed',
            'failureType': 'TimeoutError',
            'failureCode': 'native-cancellation-queue-not-empty',
            'engineDriverExitCode': 23,
            'engineDriverStage': 'native-diagnostics',
            'checksPassed': 1,
            'checksFailed': 1,
            'cleanupErrors': [{
                'operation': 'native.stop', 'errorType': 'TimeoutError', 'elapsedMs': 600000,
                'resource': 'native-owner',
            }],
            'retainedFixture': True,
        })
        serialized = json.dumps(output)
        self.assertNotIn('private', serialized)
        self.assertNotIn('conversation text', serialized)
        self.assertNotIn('processPid', serialized)
        self.assertNotIn('ownerPid', serialized)
        self.assertNotIn('exception', serialized)
        self.assertNotIn('stderrTail', serialized)

        report['engineDriverExitCode'] = 'C:\\private\\runner'
        self.assertNotIn('engineDriverExitCode', helpers['public_console_report'](report))

        report['engineDriverStage'] = 'C:\\private\\runner'
        self.assertNotIn('engineDriverStage', helpers['public_console_report'](report))

        report['failureCode'] = 'engine-driver-exited-before-response'
        self.assertEqual(helpers['public_console_report'](report)['failureCode'], 'engine-driver-exited-before-response')

        report['failureCode'] = 'private path and conversation text'
        self.assertNotIn('failureCode', helpers['public_console_report'](report))

    def test_starting_cancel_native_lookup_uses_exact_event_request(self):
        module = ast.parse(PROBE.read_text(encoding='utf-8'))
        function = next(node for node in ast.walk(module)
                        if isinstance(node, ast.AsyncFunctionDef) and node.name == 'held_request_evidence')
        scope = {'asyncio': asyncio, 'records': [], 'provider_trace': [], 'actions': []}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(PROBE), 'exec'), scope)
        held_request_evidence = scope['held_request_evidence']

        class Engine:
            def __init__(self, requests):
                self.requests = requests
                self.calls = []

            async def command(self, action, **fields):
                self.calls.append((action, fields))
                if action == 'snapshot':
                    return {'requests': self.requests, 'approvals': []}
                if action == 'findRequest':
                    if fields != {'requestId': 'cancel-request', 'eventId': 'cancel'}:
                        raise AssertionError('native lookup did not use the exact cancel request')
                    return {'nativeRequest': {
                        'state': 'not_found', 'turnAssigned': False, 'queuedSubmissionFound': False,
                        'mixed': False, 'finalAnswerPresent': False, 'requestId': 'private-id',
                        'text': 'private fixture content',
                    }}
                raise AssertionError(f'unexpected engine command: {action}')

        class Peer:
            events = []

            async def call(self, method, params):
                return {'thread': {'status': {'type': 'idle'}}}

        async def read(requests):
            engine = Engine(requests)
            evidence = await held_request_evidence(engine, Peer(), 'fixture-thread', event_id='cancel')
            return evidence, engine.calls

        requests = [
            {'id': 'cancel-request', 'eventId': 'cancel', 'status': 'starting', 'turnId': None},
            {'id': 'following-request', 'eventId': 'after-shell-cancel', 'status': 'queued', 'turnId': None},
        ]
        evidence, calls = asyncio.run(read(requests))
        self.assertEqual(calls, [('snapshot', {}), ('findRequest', {'requestId': 'cancel-request', 'eventId': 'cancel'})])
        self.assertEqual(evidence['nativeRequest'], {
            'state': 'not_found', 'turnAssigned': False, 'queuedSubmissionFound': False,
            'mixed': False, 'finalAnswerPresent': False,
        })
        self.assertNotIn('private-id', json.dumps(evidence))
        self.assertNotIn('private fixture content', json.dumps(evidence))

        duplicated = requests + [{'id': 'duplicate-cancel', 'eventId': 'cancel', 'status': 'starting', 'turnId': None}]
        evidence, calls = asyncio.run(read(duplicated))
        self.assertEqual(calls, [('snapshot', {})])
        self.assertNotIn('nativeRequest', evidence)

    def test_stale_cancel_queue_snapshot_is_drained_before_close_ack(self):
        helpers = load_helpers(self)

        class Stdin:
            def __init__(self):
                self.writes = []

            def write(self, value):
                self.writes.append(value)

            async def drain(self):
                return None

        class Stdout:
            def __init__(self):
                self.first = True
                self.responses = [
                    b'{"action":"snapshot","requests":[{"id":"cancel-request","eventId":"cancel","status":"starting","turnId":null},{"id":"following-request","eventId":"after-shell-cancel","status":"queued","turnId":null}],"approvals":[]}\n',
                    b'{"action":"close","stopped":true,"backendAlive":true}\n',
                ]
                self.read_actions = []
                self.read_requests = []

            async def readline(self):
                if self.first:
                    self.first = False
                    raise TimeoutError()
                response = self.responses.pop(0)
                value = json.loads(response)
                self.read_actions.append(value['action'])
                self.read_requests.extend(value.get('requests', []))
                return response

        class Process:
            def __init__(self):
                self.stdout = Stdout()
                self.stdin = Stdin()
                self.returncode = None

            async def wait(self):
                self.returncode = 0
                return self.returncode

        async def close_after_snapshot_timeout():
            process = Process()
            driver = helpers['EngineDriver'](process)
            with self.assertRaises(TimeoutError) as primary:
                await driver.command('snapshot')

            errors = []
            await helpers['record_cleanup_error'](
                errors, 'engine.close', 'engine-driver-process', driver.close)

            self.assertEqual(errors, [])
            self.assertIs(type(primary.exception), TimeoutError)
            self.assertEqual(process.stdout.read_actions, ['snapshot', 'close'])
            self.assertEqual([json.loads(value)['action'] for value in process.stdin.writes], ['snapshot', 'close'])
            self.assertEqual([(row['id'], row['eventId'], row['status']) for row in process.stdout.read_requests], [
                ('cancel-request', 'cancel', 'starting'),
                ('following-request', 'after-shell-cancel', 'queued'),
            ])
            self.assertIsNone(helpers['cleanup_failure_message'](primary.exception, errors))
            self.assertEqual(driver.startup_stage, 'engine-close-ack')
            self.assertEqual(process.returncode, 0)

        asyncio.run(close_after_snapshot_timeout())

if __name__ == '__main__':
    unittest.main()

import ast
import asyncio
import json
import pathlib
import re
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = ROOT / 'scripts/shared-protocol-probe.py'
HELPERS = {'safe_error_type', 'safe_failure_code', 'safe_engine_driver_stage', 'record_cleanup_error', 'cleanup_failure_message', 'public_console_report', 'EngineDriver'}


def load_helpers(test):
    module = ast.parse(PROBE.read_text(encoding='utf-8'))
    functions = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in HELPERS]
    missing = HELPERS - {function.name for function in functions}
    test.assertEqual(missing, set(), f'missing testable cleanup diagnostics: {sorted(missing)}')
    namespace = {'re': re, 'json': json, 'time': time, 'asyncio': asyncio, 'ENGINE_READ_TIMEOUT_SECONDS': 1}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(PROBE), 'exec'), namespace)
    return namespace


class CleanupDiagnostics(unittest.TestCase):
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
        self.assertIsNone(helpers['safe_engine_driver_stage']('C:\\private\\runner'))

    def test_successful_cleanup_leaves_no_error(self):
        helpers = load_helpers(self)
        errors = []

        async def close():
            return None

        asyncio.run(helpers['record_cleanup_error'](errors, 'engine.close', 'engine-driver-process', close, 101, 202))
        self.assertEqual(errors, [])
        self.assertIsNone(helpers['cleanup_failure_message'](None, errors))

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
        self.assertIsNone(helpers['cleanup_failure_message'](ValueError('primary failure'), errors))

    def test_engine_close_cleanup_preserves_allowlisted_driver_failure_diagnostics(self):
        helpers = load_helpers(self)

        class Process:
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"probeStage":"native-diagnostics"}\n')
                self.stdout.feed_eof()
                self.returncode = 23

        errors = []

        async def record():
            driver = helpers['EngineDriver'](Process())

            async def close():
                await driver.read()

            await helpers['record_cleanup_error'](errors, 'engine.close', 'engine-driver-process', close, 101, 202)

        asyncio.run(record())
        self.assertEqual(errors[0]['failureCode'], 'engine-driver-exited-before-response')
        self.assertEqual(errors[0]['engineDriverExitCode'], 23)
        self.assertEqual(errors[0]['engineDriverStage'], 'native-diagnostics')

        report = helpers['public_console_report']({'result': 'failed', 'cleanupErrors': errors})
        self.assertEqual(report['cleanupErrors'][0]['failureCode'], 'engine-driver-exited-before-response')
        self.assertEqual(report['cleanupErrors'][0]['engineDriverExitCode'], 23)
        self.assertEqual(report['cleanupErrors'][0]['engineDriverStage'], 'native-diagnostics')
        self.assertNotIn('processPid', json.dumps(report))
        self.assertNotIn('ownerPid', json.dumps(report))

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


if __name__ == '__main__':
    unittest.main()

import ast
import asyncio
import json
import pathlib
import re
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = ROOT / 'scripts/shared-protocol-probe.py'
HELPERS = {'safe_error_type', 'safe_failure_code', 'record_cleanup_error', 'cleanup_failure_message', 'public_console_report'}


def load_helpers(test):
    module = ast.parse(PROBE.read_text(encoding='utf-8'))
    functions = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in HELPERS]
    missing = HELPERS - {function.name for function in functions}
    test.assertEqual(missing, set(), f'missing testable cleanup diagnostics: {sorted(missing)}')
    namespace = {'re': re, 'time': time}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(PROBE), 'exec'), namespace)
    return namespace


class CleanupDiagnostics(unittest.TestCase):
    def test_failure_code_only_maps_known_static_native_assertions(self):
        helpers = load_helpers(self)
        self.assertEqual(
            helpers['safe_failure_code'](AssertionError('Native background terminals are not confirmed empty through EOF')),
            'native-background-terminals-not-empty',
        )
        self.assertEqual(
            helpers['safe_failure_code'](AssertionError('Native cancellation queue is not confirmed empty through EOF')),
            'native-cancellation-queue-not-empty',
        )
        self.assertIsNone(helpers['safe_failure_code'](AssertionError('private path and conversation text')))

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

    def test_console_report_exposes_only_bounded_allowlisted_fields(self):
        helpers = load_helpers(self)
        report = {
            'result': 'failed',
            'failureType': 'TimeoutError',
            'failureCode': 'native-cancellation-queue-not-empty',
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

        report['failureCode'] = 'private path and conversation text'
        self.assertNotIn('failureCode', helpers['public_console_report'](report))


if __name__ == '__main__':
    unittest.main()

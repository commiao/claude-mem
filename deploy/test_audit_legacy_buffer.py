import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit_legacy_buffer.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class LegacyAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def line(self, ms, channel, body):
        return f'[2026-09-28 01:00:00.{ms:03}] [INFO ] [{channel:6}] [session-7] {body}\n'

    def run_logs(self, text):
        p = self.root / 'claude-mem-test.log'
        p.write_text(text)
        return audit.audit_logs([p], '2026-09-28 00:00:00.000')

    def enqueue(self, ms, ident, depth):
        return self.line(ms, 'QUEUE', f'ENQUEUED | sessionDbId=7 | messageId={ident} | type=observation | tool=Bash(echo hi) | depth={depth}')

    def test_depth_suffix_and_uncounted_receipt_are_distinct(self):
        result = self.run_logs(self.enqueue(1, 1, 1) + self.enqueue(2, 2, 2)
            + self.line(3, 'DB', 'STORED | sessionDbId=7 | obsCount=1') + self.enqueue(4, 3, 2))
        self.assertEqual([m['id'] for m in result['sessions'][7]['messages']], [2, 3])
        self.assertFalse(result['sessions'][7]['uncertain_receipt'])
        result = self.run_logs(self.enqueue(1, 1, 1) + self.line(2, 'DB', 'STORED | sessionDbId=7 | obsCount=1'))
        self.assertTrue(result['sessions'][7]['uncertain_receipt'])

    def test_pause_sample_and_removal(self):
        result = self.run_logs(self.enqueue(1, 1, 1) + self.enqueue(2, 2, 2)
            + self.line(3, 'SESSION', 'Generator paused for transport; preserving buffered work {pendingCount=1}'))
        self.assertEqual([m['id'] for m in result['sessions'][7]['messages']], [2])
        result = self.run_logs(self.enqueue(1, 1, 1) + self.line(2, 'SESSION', 'Session removed from active sessions'))
        self.assertEqual(result['sessions'][7]['messages'], [])

    def test_epoch_conflicts_and_missing_history_fail_closed(self):
        result = self.run_logs(self.enqueue(1, 5, 9) + self.enqueue(2, 5, 9))
        self.assertEqual(len(result['errors']), 1)
        self.assertEqual(len(result['sessions'][7]['gaps']), 1)

    def test_multiline_command_is_one_record(self):
        text = self.enqueue(1, 1, 1).replace('echo hi', 'echo hi\necho bye')
        result = self.run_logs(text)
        self.assertEqual(result['sessions'][7]['messages'][0]['formatted_tool'], 'Bash(echo hi\necho bye)')

    def test_future_or_different_output_cannot_be_used_as_unique_evidence(self):
        result = self.run_logs(self.enqueue(500, 1, 1))
        timestamp = audit.millis('2026-09-28 01:00:00.500')
        p = self.root / 'source.jsonl'
        rows = []
        for ident, delta, output in [('a', -100, 'one'), ('b', -90, 'two'), ('future', 1, 'one')]:
            rows.append({'type': 'event_msg', 'payload': {'type': 'item_completed', 'completed_at_ms': timestamp+delta,
                'item': {'type': 'CommandExecution', 'id': ident, 'command': ['zsh', '-c', 'echo hi'], 'aggregated_output': output}}})
        p.write_text('\n'.join(json.dumps(r) for r in rows))
        audit.match_sources(result, [p])
        message = result['sessions'][7]['messages'][0]
        self.assertEqual(message['source_status'], 'ambiguous')
        self.assertEqual(len(message['source_evidence']), 2)
        self.assertFalse(result['automatic_replay_allowed'])

    def test_response_serialization_requires_a_prior_call(self):
        event = {'timestamp_kind': 'response_serialization', 'call_started_at_ms': 100,
                 'completed_at_ms': 900}
        self.assertTrue(audit.temporal_match(event, 700, 1000))
        self.assertFalse(audit.temporal_match(event, 99, 1000))
        self.assertFalse(audit.temporal_match(event, 1901, 1000))


if __name__ == '__main__':
    unittest.main()

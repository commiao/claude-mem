import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from import_legacy_queue_evidence import stage


class LegacyQueueEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'new.sqlite3'
        with sqlite3.connect(self.db) as db:
            db.execute('CREATE TABLE observer_tasks(id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute("INSERT INTO observer_tasks VALUES ('new-task', 'original')")
        self.audit = self.root / 'audit.json'
        self.data = {
            'worker_started_at': '2026-09-20 15:16:00.000',
            'automatic_replay_allowed': False, 'errors': [],
            'source_counts': {'unique_content': 1},
            'sessions': {'17': {'content_session_id': 'original-session', 'gaps': [],
                'uncertain_receipt': False, 'messages': [{'id': 42, 'kind': 'observation',
                    'source_status': 'unique_content', 'source_evidence': [{}]}]}}}

    def write_audit(self):
        self.audit.write_text(json.dumps(self.data))

    def test_stage_keeps_runtime_tasks_unchanged_and_is_idempotent(self):
        self.write_audit()
        first = stage(self.audit, self.db, self.root / 'evidence', 1)
        self.assertEqual(first['staged'], 1)
        self.assertEqual(stage(self.audit, self.db, self.root / 'evidence', 1), first)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT * FROM observer_tasks').fetchall(),
                             [('new-task', 'original')])
            self.assertEqual(db.execute('SELECT message_id, disposition FROM legacy_queue_evidence').fetchall(),
                             [(42, 'needs_manual_reconciliation')])

    def test_uncertain_boundary_never_imports(self):
        self.data['sessions']['17']['uncertain_receipt'] = True
        self.write_audit()
        with self.assertRaisesRegex(ValueError, 'uncertain queue boundary'):
            stage(self.audit, self.db, self.root / 'evidence', 1)
        with sqlite3.connect(self.db) as db:
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_queue_evidence'").fetchone())

    def test_changed_epoch_evidence_is_rejected(self):
        self.write_audit()
        stage(self.audit, self.db, self.root / 'evidence', 1)
        self.data['sessions']['17']['messages'][0]['id'] = 43
        self.audit.write_text(json.dumps(self.data))
        with self.assertRaisesRegex(ValueError, 'different evidence'):
            stage(self.audit, self.db, self.root / 'evidence', 1)


if __name__ == '__main__':
    unittest.main()

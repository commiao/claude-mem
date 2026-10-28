"""Filter metric evidence contracts; no model and only disposable test SQLite."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from llm_eval import engine
from llm_eval.evidence import digest, read, seal
from llm_eval.report import report
from claude_mem_eval import Observation
from claude_mem_eval.filter_metrics import review_targets, raw_hash
from claude_mem_eval.filter_persistence import export_receipt


OBS = {'type': 'discovery', 'title': 'Configuration discovered', 'subtitle': None,
       'facts': ['Durable finding'], 'narrative': None, 'concepts': [], 'files_read': [], 'files_modified': []}


class ContractAdapter(Observation):
    def describe(self):
        return {'sdk': 1, 'id': 'test.mem.filter', 'version': '1', 'policy_version': 'uncalibrated'}

    def build_requests(self, cases, profile):
        return [{'id': c['id'], 'case_ids': [c['id']], 'system': c['request']['system'],
                 'query': c['request']['messages'][0]['content'], 'body': c['request']} for c in cases]

    def parse_response(self, request, text):
        return json.loads(text)  # Fixture transport; the parser has separate production contracts.


class FilterMetricIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.adapter = ContractAdapter()
        self.case = {'id': 'one', 'kind': 'observation', 'source': {'batch_id': 'batch-one'},
                     'request': {'model': 'claude_mem.observation', 'system': 'system',
                                 'messages': [{'role': 'user', 'content': 'Durable finding'}]}}

    def make_run(self, *, cases=None, skip=False, submit=True):
        engine.freeze(self.adapter, cases or [self.case], self.root / 'dataset.json')
        engine.plan(self.adapter, self.root / 'dataset.json', [{'id': 'arm', 'executor': 'manual', 'model': 'unverified-model'}], self.root / 'plan.json')
        run = self.root / 'run'
        engine.prepare(self.root / 'plan.json', run)
        p = read(run / 'plan.json')
        if submit:
            text = json.dumps({'valid': True, 'parser_valid': True, 'value': {
                'observations': [] if skip else [OBS], 'summary': None, 'skipped': skip}})
            engine.import_results(self.adapter, run, [{'id': j['id'], 'plan_sha256': p['sha256'],
                'request_sha256': j['request_sha256'], 'text': text} for j in p['jobs']])
        return run

    def annotation(self, run):
        p = read(run / 'plan.json')
        scored = engine.score(self.adapter, run)
        targets = scored['adapter_summary']['review_targets']
        source = targets['cases'][0]
        target = targets['outputs'][0]
        return {'schema_version': 1, 'type': 'claude-mem-filter-review', 'plan_sha256': p['sha256'],
                'reviewer': {'name': 'test reviewer', 'method': 'human'},
                'cases': [{**source, 'input_value': 'none', 'source_quote': 'Durable finding', 'rationale': 'fixture input label'}],
                'outputs': [{**target, 'value': 'none', 'fact_support': 'incorrect', 'source_quote': 'Durable finding',
                             'output_quote': 'Durable finding', 'rationale': 'fixture output label'}]}

    def test_unlabelled_outputs_unknown_and_database_not_assumed(self):
        run = self.make_run()
        fq = engine.score(self.adapter, run)['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertEqual(fq['generated']['count'], 1)
        self.assertEqual(fq['generated']['value_counts'], {'unknown': 1})
        self.assertEqual(fq['generated']['no_value_contamination']['upper_bound'], 1)
        self.assertIsNone(fq['conversion']['unique_new_observations'])
        self.assertIsNone(fq['conversion']['batches_with_new_observations']['rate'])
        self.assertIsNone(fq['inputs']['source_tasks'])

    def test_bound_labels_flow_to_shared_score_html_csv_and_do_not_change_plain_score(self):
        run = self.make_run()
        annotations = self.annotation(run)
        result = engine.score(self.adapter, run, annotations=annotations)
        fq = result['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertEqual(fq['generated']['no_value_contamination']['rate'], 1)
        self.assertEqual(fq['generated']['incorrect_facts']['rate'], 1)
        self.assertEqual(fq['inputs']['no_value_generation_leakage']['rate'], 1)
        self.assertIsNone(fq['conversion']['unique_new_observations'])
        report(self.adapter, run, self.root / 'report', annotations=annotations)
        self.assertIn('filter_quality.generated.no_value_contamination', (self.root / 'report' / 'metrics.csv').read_text())
        self.assertEqual(engine.score(self.adapter, run)['adapter_summary']['candidates']['arm']['filter_quality']['generated']['value_counts'], {'unknown': 1})

    def test_stale_source_raw_normalized_hashes_indices_and_quotes_are_rejected(self):
        run = self.make_run()
        original = self.annotation(run)
        for field in ('source_sha256', 'raw_sha256', 'output_sha256', 'job_id', 'output_index', 'output_quote', 'source_quote'):
            changed = copy.deepcopy(original)
            changed['outputs'][0][field] = 99 if field == 'output_index' else 'changed'
            with self.subTest(field=field), self.assertRaises(ValueError):
                engine.score(self.adapter, run, annotations=changed)
        changed = copy.deepcopy(original)
        changed['cases'][0]['source_sha256'] = 'stale'
        with self.assertRaises(ValueError):
            engine.score(self.adapter, run, annotations=changed)
        changed = copy.deepcopy(original)
        changed['outputs'][0]['persisted_ids'] = [88]
        with self.assertRaisesRegex(ValueError, 'cannot assert'):
            engine.score(self.adapter, run, annotations=changed)

    def test_pending_execution_not_treated_as_noise_or_false_rejection(self):
        run = self.make_run(submit=False)
        fq = engine.score(self.adapter, run)['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertEqual(fq['execution_coverage']['pending_case_repetitions'], 1)
        self.assertIsNone(fq['inputs']['no_value_rejection']['rate'])
        self.assertIsNone(fq['conversion']['batches_with_new_observations']['rate'])

    def database(self, run, *, merged=False, reply=None):
        plan = read(run / 'plan.json')
        scored = engine.score(self.adapter, run)
        raw = reply or scored['outputs'][plan['jobs'][0]['id']]['raw']
        path = self.root / 'history.db'
        c = sqlite3.connect(path)
        c.executescript('''CREATE TABLE observer_queue_batches (id TEXT PRIMARY KEY, body TEXT,result TEXT,state TEXT);
            CREATE TABLE observer_tasks (id TEXT PRIMARY KEY,state TEXT,outcome TEXT);
            CREATE TABLE observer_queue_members (batch_id TEXT,task_id TEXT);
            CREATE TABLE observations (id INTEGER PRIMARY KEY,type TEXT,title TEXT,subtitle TEXT,facts TEXT,narrative TEXT,
                concepts TEXT,files_read TEXT,files_modified TEXT);''')
        c.execute('INSERT INTO observer_queue_batches VALUES (?,?,?,?)', ('batch-one', json.dumps(self.case['request']),
            json.dumps({'content': [{'type': 'text', 'text': raw}]}), 'succeeded'))
        outcome = {'observationIds': [81], 'insertedObservationIds': [] if merged else [81], 'mergedIntoExisting': [merged]}
        # Two members share one complete outcome. They must not double the memory count.
        for ident in ('task-a', 'task-b'):
            c.execute('INSERT INTO observer_tasks VALUES (?,?,?)', (ident, 'succeeded', json.dumps(outcome)))
            c.execute('INSERT INTO observer_queue_members VALUES (?,?)', ('batch-one', ident))
        c.execute('INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)', (81, OBS['type'], OBS['title'], None,
            json.dumps(OBS['facts']), None, '[]', '[]', '[]'))
        c.commit()
        c.close()
        return path

    def test_read_only_receipt_distinguishes_new_from_merged_and_deduplicates_outcomes(self):
        run = self.make_run()
        path = self.database(run)
        before = path.read_bytes()
        receipt = export_receipt(self.adapter, run, path, self.root / 'receipt.json')
        self.assertEqual(path.read_bytes(), before)
        annotations = self.annotation(run)
        annotations['persistence_receipt'] = receipt
        fq = engine.score(self.adapter, run, annotations=annotations)['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertEqual(fq['conversion']['unique_new_observations'], 1)
        self.assertEqual(fq['inputs']['source_tasks'], 2)
        self.assertEqual(fq['newly_persisted']['count'], 1)
        # Tamper a new-ID assertion into a different ID even with a recomputed local seal.
        bad = copy.deepcopy(receipt)
        bad.pop('sha256')
        bad['rows'][0]['outputs'][0]['inserted_ids'] = [999]
        annotations['persistence_receipt'] = seal(bad)
        with self.assertRaisesRegex(ValueError, 'inserted IDs'):
            engine.score(self.adapter, run, annotations=annotations)

    def test_existing_merged_rows_are_not_new_insertions(self):
        run = self.make_run()
        path = self.database(run, merged=True)
        receipt = export_receipt(self.adapter, run, path, self.root / 'receipt.json')
        a = self.annotation(run)
        a['persistence_receipt'] = receipt
        fq = engine.score(self.adapter, run, annotations=a)['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertEqual(fq['conversion']['unique_new_observations'], 0)
        self.assertEqual(fq['conversion']['batches_with_new_observations']['rate'], 0)
        self.assertEqual(fq['newly_persisted']['count'], 0)

    def test_database_reply_mismatch_and_changed_readback_never_claim_new_row(self):
        run = self.make_run()
        path = self.database(run, reply='another reply')
        with self.assertRaisesRegex(ValueError, 'reply does not match'):
            export_receipt(self.adapter, run, path, self.root / 'bad.json')
        c = sqlite3.connect(path)
        p = read(run / 'plan.json')
        raw = engine.score(self.adapter, run)['outputs'][p['jobs'][0]['id']]['raw']
        c.execute('UPDATE observer_queue_batches SET result=?', (json.dumps({'content': [{'type': 'text', 'text': raw}]}),))
        c.execute('UPDATE observations SET facts=?', ('["changed after history"]',))
        c.commit()
        c.close()
        receipt = export_receipt(self.adapter, run, path, self.root / 'partial.json')
        self.assertFalse(receipt['rows'][0]['complete'])
        a = self.annotation(run)
        a['persistence_receipt'] = receipt
        fq = engine.score(self.adapter, run, annotations=a)['adapter_summary']['candidates']['arm']['filter_quality']
        self.assertIsNone(fq['conversion']['unique_new_observations'])


if __name__ == '__main__':
    unittest.main()

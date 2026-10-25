"""Offline contracts: python3 -m unittest discover -s tests/evaluation -p 'test_*.py'."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('observer_bench', ROOT / 'scripts/observer_bench.py')
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)

XML = '<observation><type>bugfix</type><title>Session ownership</title><facts><fact>Use session_id; 12 tests passed.</fact></facts></observation>'
SUMMARY = '<summary><request>Fix session_id</request><completed>12 tests passed</completed><next_steps>Deployment pending</next_steps></summary>'


class ObserverBenchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shared = tempfile.TemporaryDirectory()
        cls.bench = Path(cls.shared.name) / 'frozen'
        cls.cases = bench.read(ROOT / 'docs/examples/observer-bench-cases.json')
        bench.freeze(cls.cases, cls.bench)

    @classmethod
    def tearDownClass(cls):
        cls.shared.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_dir(self, name='candidate', **kwargs):
        path = self.root / name
        bench.prepare(self.bench, path, executor=kwargs.pop('executor', 'cursor'),
                      model=kwargs.pop('model', 'test-model'), label=kwargs.pop('label', name), **kwargs)
        return path

    def answers(self, path):
        _, run, _, _ = bench.load_run(path)
        return [{'id': i['id'], 'request_sha256': i['request_sha256'],
                 'text': SUMMARY if i['case_id'] == 'synthetic-summary' else
                         '<skip_summary reason="noise"/>' if i['case_id'] == 'synthetic-noise' else XML,
                 'stop_reason': 'end_turn', 'elapsed_ms': 100, 'usage': None, 'cost': None}
                for i in run['items']]

    def completed(self, name='candidate', **kwargs):
        path = self.run_dir(name, **kwargs)
        bench.import_results(path, self.answers(path))
        return path

    def test_freeze_uses_actual_prompt_and_cannot_overwrite(self):
        _, frozen = bench.load_bench(self.bench)
        self.assertIn('[[cm-task:synthetic-bugfix:0]]', frozen['cases'][0]['prompts'][0])
        self.assertIn('12 pass', frozen['cases'][0]['prompts'][1])
        with self.assertRaises(FileExistsError):
            bench.freeze(self.cases, self.bench)

    def test_packets_do_not_leak_gold_or_another_candidates_answers(self):
        path = self.run_dir()
        packets = list((path / 'packets').glob('*.json'))
        self.assertTrue(packets)
        for packet in packets:
            data = bench.read(packet)
            self.assertNotIn('expected', data)
            self.assertNotIn('required_facts', packet.read_text())

    def test_missing_response_is_in_denominator_and_cost_unknown(self):
        path = self.run_dir()
        bench.import_results(path, self.answers(path)[:1])
        score = bench.score_runs([path])['runs'][0]
        self.assertEqual(score['missing'], score['requests'] - 1)
        self.assertEqual(score['valid_cases'], 1)
        self.assertEqual(score['total_tokens'], None)
        self.assertEqual(score['costs'], {})
        self.assertEqual(score['semantic_means'], None)

    def test_duplicate_or_wrong_fingerprint_cannot_partially_import(self):
        path = self.run_dir()
        rows = self.answers(path)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            bench.import_results(path, [rows[0], rows[0]])
        rows[-1]['request_sha256'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            bench.import_results(path, rows)
        self.assertFalse((path / 'responses').exists())

    def test_result_is_immutable_but_exact_import_is_idempotent(self):
        path = self.completed()
        rows = self.answers(path)
        self.assertEqual(bench.import_results(path, rows)['imported'], 0)
        rows[0]['text'] += ' altered'
        with self.assertRaisesRegex(ValueError, 'immutable'):
            bench.import_results(path, rows)

    def test_parser_rejection_truncation_and_wrong_output_kind(self):
        path = self.run_dir()
        rows = self.answers(path)
        rows[0]['text'] = '<skip_summary reason="noise">Nothing</skip_summary>'
        rows[1]['text'] = XML
        rows[1]['stop_reason'] = 'max_tokens'
        rows[4]['text'] = XML
        bench.import_results(path, rows)
        data = bench.score_runs([path])['runs'][0]
        self.assertEqual(data['valid_cases'], 3)
        self.assertEqual(data['truncated_cases'], 1)
        self.assertFalse(data['per_case'][4]['valid'])

    def test_different_batch_sizes_compare_same_cases_and_aggregate_parts(self):
        small = self.completed('single', batch_items=1)
        big = self.completed('batch', batch_items=20)
        data = bench.score_runs([small, big])['runs']
        self.assertEqual(data[0]['cases'], data[1]['cases'])
        self.assertGreater(data[0]['requests'], data[1]['requests'])
        self.assertGreater(data[0]['duplicate_facts'], data[1]['duplicate_facts'])

    def test_selection_mismatch_is_not_a_fair_comparison(self):
        a = self.completed('all')
        b = self.completed('dev', split='dev')
        with self.assertRaisesRegex(ValueError, 'identical frozen cases'):
            bench.score_runs([a, b])

    def test_prompt_variant_is_fingerprinted_and_compare_allowed(self):
        a = self.completed('base')
        b = self.completed('concise', prompt_append='Keep at most three concise facts.')
        data = bench.score_runs([a, b])['runs']
        self.assertNotEqual(data[0]['prompt_append_sha256'], data[1]['prompt_append_sha256'])

    def test_full_missing_usage_cannot_be_reported_as_free(self):
        path = self.run_dir()
        rows = self.answers(path)
        rows[0]['usage'] = {'total_tokens': 10}
        rows[0]['cost'] = {'value': 0.1, 'unit': 'USD', 'basis': 'measured'}
        rows[1]['cost'] = {'value': 2, 'unit': 'credits', 'basis': 'declared'}
        bench.import_results(path, rows)
        result = bench.score_runs([path])['runs'][0]
        self.assertIsNone(result['total_tokens'])
        self.assertEqual(result['known_tokens'], 10)
        self.assertFalse(result['costs_complete'])
        self.assertEqual(set(result['costs']), {'USD/measured', 'credits/declared'})

    def test_actual_model_mismatch_is_failure_not_a_win(self):
        path = self.run_dir()
        rows = self.answers(path)
        rows[0]['actual_model'] = 'different-model'
        bench.import_results(path, rows)
        score = bench.score_runs([path])['runs'][0]
        self.assertEqual(score['model_identity_mismatches'], 1)
        self.assertEqual(score['valid_cases'], 5)

    def test_invalid_measurements_rejected(self):
        for value in (-1, float('nan'), True):
            path = self.run_dir('bad-' + str(value))
            rows = self.answers(path)
            rows[0]['elapsed_ms'] = value
            with self.assertRaises(ValueError):
                bench.import_results(path, rows)

    def test_blind_review_binds_source_results_and_records_evidence(self):
        a = self.completed('candidate-A')
        b = self.completed('candidate-B')
        directory = self.root / 'blind'
        bench.blind_sheet([a, b], directory, 1)
        sheet = bench.read(directory / 'review.json')
        key = bench.read(directory / 'key.private.json')
        text = json.dumps(sheet)
        self.assertNotIn('candidate-A', text)
        self.assertNotIn('candidate-B', text)
        self.assertNotIn('test-model', text)
        sheet['reviewer'] = 'offline-test-reviewer'
        for row in sheet['items']:
            row['ratings'] = {k: 3 for k in bench.SEMANTIC}
            row['evidence'] = 'Synthetic test label; not a model quality measurement.'
        result = bench.score_runs([a, b], review=sheet, review_key=key)
        self.assertEqual(result['runs'][0]['semantic_reviewed'], 6)
        self.assertEqual(result['runs'][1]['semantic_means']['coverage'], 3)
        sheet['items'][0]['evidence'] = ''
        with self.assertRaisesRegex(ValueError, 'evidence'):
            bench.score_runs([a, b], review=sheet, review_key=key)

    def test_reviews_invalidated_when_response_set_changes(self):
        path = self.completed()
        directory = self.root / 'blind'
        bench.blind_sheet([path], directory, 1)
        sheet = bench.read(directory / 'review.json')
        key = bench.read(directory / 'key.private.json')
        sheet['reviewer'] = 'reviewer'
        response_file = next((path / 'responses').glob('*.json'))
        value = bench.read(response_file)
        value['text'] += '\nchanged'
        response_file.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'responses changed'):
            bench.score_runs([path], review=sheet, review_key=key)

    def test_review_cannot_substitute_source_or_output(self):
        path = self.completed()
        directory = self.root / 'blind'
        bench.blind_sheet([path], directory, 1)
        sheet = bench.read(directory / 'review.json')
        key = bench.read(directory / 'key.private.json')
        sheet['reviewer'] = 'reviewer'
        sheet['items'][0]['outputs'][0] = 'Better imaginary answer'
        with self.assertRaisesRegex(ValueError, 'source/output changed'):
            bench.score_runs([path], review=sheet, review_key=key)

    def test_sample_is_readonly_and_labels_are_not_derived_from_old_output(self):
        db = self.root / 'queue.sqlite3'
        c = sqlite3.connect(db)
        c.executescript('''CREATE TABLE observer_queue_batches(id TEXT PRIMARY KEY,body TEXT,state TEXT,created_at INTEGER);
          CREATE TABLE observer_queue_members(task_id TEXT,batch_id TEXT);
          CREATE TABLE observer_queue_inputs(task_id TEXT,kind TEXT,context TEXT);''')
        request = {'system': 'Actual worker prompt', 'messages': [{'role': 'user', 'content': 'Source'}]}
        for i, (kind, state) in enumerate([('observation', 'failed'), ('summary', 'succeeded')]):
            c.execute('insert into observer_queue_batches values(?,?,?,?)', (str(i), json.dumps(request), state, i))
            c.execute('insert into observer_queue_members values(?,?)', (str(i), str(i)))
            c.execute('insert into observer_queue_inputs values(?,?,?)', (str(i), kind, '{"project":"test"}'))
        c.commit(); c.close()
        before = db.read_bytes()
        target = self.root / 'sample.json'
        bench.sample_database(db, target, 2, 123)
        cases = bench.read(target)
        self.assertEqual(len(cases), 2)
        self.assertTrue(all(c['expected'] == {} and c['request'] == request for c in cases))
        self.assertEqual(before, db.read_bytes())
        bench.freeze(cases, self.root / 'captured')
        with self.assertRaisesRegex(ValueError, 'cannot be rebatched'):
            bench.prepare(self.root / 'captured', self.root / 'invalid-rebatch', executor='cursor',
                          model='model', label='invalid', batch_items=1)

    def test_raw_record_sampling_supports_real_rebatching_without_future_summary_context(self):
        db = self.root / 'raw.sqlite3'
        c = sqlite3.connect(db)
        c.executescript('''CREATE TABLE observer_queue_batches(id TEXT PRIMARY KEY,body TEXT,state TEXT,created_at INTEGER);
          CREATE TABLE observer_queue_members(task_id TEXT,batch_id TEXT);
          CREATE TABLE observer_queue_inputs(task_id TEXT,kind TEXT,context TEXT);
          CREATE TABLE observer_tasks(id TEXT,payload TEXT,enqueued_at_epoch INTEGER);''')
        request = {'system': 'Frozen old prompt', 'messages': [{'role': 'user', 'content': 'Old bounded summary'}]}
        c.execute('insert into observer_queue_batches values(?,?,?,?)', ('batch', json.dumps(request), 'succeeded', 1))
        for i in range(3):
            c.execute('insert into observer_queue_members values(?,?)', (str(i), 'batch'))
            c.execute('insert into observer_queue_inputs values(?,?,?)', (str(i), 'observation', '{"project":"test","userPrompt":"Keep facts"}'))
            c.execute('insert into observer_tasks values(?,?,?)', (str(i), json.dumps({
                'tool_name': 'Read', 'tool_input': {'path': 'x'}, 'tool_response': 'fact ' + str(i)}), 1760000000000 + i))
        c.commit(); c.close()
        target = self.root / 'sample-records.json'
        bench.sample_database(db, target, 1, 123, raw_records=True)
        cases = bench.read(target)
        self.assertEqual(len(cases[0]['records']), 3)
        self.assertEqual(cases[0]['records'][1]['tool_output'], 'fact 1')
        self.assertNotIn('request', cases[0])
        bench.freeze(cases, self.root / 'raw-frozen')
        result = bench.prepare(self.root / 'raw-frozen', self.root / 'small-batches', executor='cursor',
                               model='model', label='model', batch_items=1)
        self.assertEqual(result['requests'], 3)

    def test_native_preview_never_probes_or_calls_a_tool(self):
        path = self.run_dir(executor='codex')
        with patch.object(bench.importlib, 'import_module', side_effect=AssertionError('must not call')):
            result = bench.native_run(path, None)
        self.assertIn('preview', result['execution'])
        self.assertFalse((path / 'attempts').exists())

    def test_interrupted_native_attempt_cannot_automatically_replay(self):
        path = self.run_dir(executor='claude')
        _, run, _, _ = bench.load_run(path)
        fake = self.root / 'runtime'
        (fake / 'utils').mkdir(parents=True)
        (fake / 'tools').mkdir()
        (fake / 'utils/cli_runtime.py').touch()
        (fake / 'tools/extract_bench.py').touch()
        bench.write(path / 'attempts' / (run['items'][0]['id'] + '.json'), {'at': 'interrupted'})
        runtime = types.SimpleNamespace(cli_environment=lambda **k: ({}, {}), code_fingerprint=lambda: 'test-runtime',
            probe_context=lambda **k: {'configuration_sha256': 'test-config', 'host_sha256': 'test-host'})
        adapters = types.SimpleNamespace(ADAPTERS={'claude': lambda *a, **k: self.fail('must not call')})
        with patch.object(bench.importlib, 'import_module', side_effect=[runtime, adapters]):
            with self.assertRaisesRegex(ValueError, 'outcome unknown'):
                bench.native_run(path, fake, execute=True)

    def test_native_contract_records_one_request_and_never_replays_after_completion(self):
        path = self.run_dir(executor='claude', limit=1)
        fake = self.root / 'runtime'
        (fake / 'utils').mkdir(parents=True); (fake / 'tools').mkdir()
        (fake / 'utils/cli_runtime.py').touch(); (fake / 'tools/extract_bench.py').touch()
        calls = []
        def call(model, system, query, **kwargs):
            calls.append(query)
            self.assertEqual(model, 'test-model')
            return {'text': XML, 'stop': 'end_turn', 'error': None, 'tokens': 50,
                    'tokens_known': True, 'credits': None, 'actual_models': [model]}
        runtime = types.SimpleNamespace(cli_environment=lambda **k: ({}, {}), code_fingerprint=lambda: 'test-runtime',
            probe_context=lambda **k: {'configuration_sha256': 'test-config', 'host_sha256': 'test-host'},
            probe=lambda *a, **k: {'status': 'ready', 'cost': {'calls': 1, 'tokens': 1}},
            invoke=lambda function, *args: function(*args))
        adapters = types.SimpleNamespace(ADAPTERS={'claude': call})
        with patch.object(bench.importlib, 'import_module', side_effect=[runtime, adapters]):
            self.assertEqual(bench.native_run(path, fake, execute=True)['new_calls'], 1)
        with patch.object(bench.importlib, 'import_module', side_effect=[runtime, adapters]):
            self.assertEqual(bench.native_run(path, fake, execute=True)['new_calls'], 0)
        self.assertEqual(len(calls), 1)
        result = bench.score_runs([path])['runs'][0]
        self.assertEqual(result['valid_cases'], 1)
        self.assertEqual(result['total_tokens'], 50)
        self.assertEqual(len(result['preflight_usage']), 1)
        self.assertIsNone(result['costs'].get('USD/measured'))

    def test_report_is_standalone_and_escapes_untrusted_labels(self):
        path = self.completed('html-label', label='<script>alert(1)</script>')
        result = bench.report([path], self.root / 'report')
        document = Path(result['report']).read_text()
        self.assertIn('未知 / 未评', document)
        self.assertNotIn('<script>alert(1)', document)
        self.assertIn('&lt;script&gt;', document)
        self.assertTrue((self.root / 'report/comparison.csv').exists())


if __name__ == '__main__':
    unittest.main()

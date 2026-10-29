"""Exercise the candidate source bridge; never a model or the live database."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from llm_eval.json_bridge import run_json_bridge

ROOT = Path(__file__).resolve().parents[2]
XML = '<observation><type>discovery</type><title>Cache plan</title><facts><fact>Fix is planned</fact></facts></observation>'


class CandidatePersistenceBridgeTest(unittest.TestCase):
    def bridge(self, records, text=XML, kind='observation'):
        with tempfile.TemporaryDirectory() as directory:
            return run_json_bridge([shutil.which('bun'), str(ROOT / 'scripts/observer-bench/shared-bridge.ts'),
                                    'parse', directory, str(ROOT / 'plugin/modes')],
                                   {'records': records, 'text': text, 'kind': kind},
                                   env=dict(os.environ, CLAUDE_MEM_DATA_DIR=directory), cwd=directory, timeout=10)

    def test_generation_denominator_remains_visible_after_persistence_rejection(self):
        result = self.bridge([{'tool_name': 'update_plan', 'tool_input': {'items': []}}])
        self.assertTrue(result['valid'])
        self.assertFalse(result['value']['skipped'])
        self.assertEqual(len(result['value']['observations']), 1)
        self.assertEqual(result['value']['observationFiltering'], {
            'sourceIndices': [], 'rejected': [{'outputIndex': 0, 'reason': 'plan_bookkeeping_only'}]})

    def test_missing_title_is_recovered_without_rewriting_the_body(self):
        result = self.bridge([{'tool_name': 'Read', 'tool_input': {'file_path': 'cache.ts'}}],
                             '<observation><type>discovery</type><subtitle>Cache key omits facts</subtitle>'
                             '<facts><fact>Same title with different facts collides</fact></facts></observation>')
        observation = result['value']['observations'][0]
        self.assertEqual(observation['title'], observation['subtitle'])
        self.assertEqual(observation['facts'], ['Same title with different facts collides'])
        self.assertEqual(result['value']['observationFiltering']['sourceIndices'], [0])

    def test_a_rejected_observation_does_not_become_a_valid_summary(self):
        result = self.bridge([], '<observation><type>discovery</type><facts><fact>Untitled</fact></facts></observation>', kind='summary')
        self.assertFalse(result['valid'])
        self.assertEqual(len(result['value']['observations']), 1)

    def test_mixed_live_evidence_stays_eligible(self):
        result = self.bridge([{'tool_name': 'update_plan', 'tool_input': {'items': []}},
                              {'tool_name': 'Read', 'tool_input': {'file_path': 'cache.ts'}}])
        self.assertEqual(result['value']['observationFiltering']['sourceIndices'], [0])


if __name__ == '__main__':
    unittest.main()

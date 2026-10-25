"""Business adapter contracts; no model or production database access."""
import tempfile
import unittest
from pathlib import Path
from llm_eval import engine
from llm_eval.evidence import read
from claude_mem_eval import Observation, Summary

ROOT=Path(__file__).resolve().parents[2]
XML='<observation><type>bugfix</type><title>Session ownership</title><facts><fact>Use session_id; 12 tests passed.</fact></facts><files_modified><file>invented.ts</file></files_modified></observation>'
SUMMARY='<summary><request>Fix session_id</request><completed>12 tests passed</completed><next_steps>Deployment pending</next_steps></summary>'

class ObserverAdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.cases=read(ROOT/'docs/examples/observer-bench-cases.json')

    def test_scenarios_separate_existing_route_preserved(self):
        with self.assertRaises(ValueError):
            Observation().validate_case(next(c for c in self.cases if c['kind']=='summary'))
        self.assertEqual(Summary().describe()['production_route'],'claude_mem.observation')
        self.assertNotIn('campaign',Summary().describe()['modes'])

    def test_production_prompts_and_normalization(self):
        request=Observation().build_requests([self.cases[0]],{})[0]
        self.assertEqual(request['production_profile']['maxBytes'],64000)
        self.assertEqual(request['body']['max_tokens'],4096)
        self.assertIn('independent batch',request['system'])
        parsed=Observation().parse_response(request,XML)
        self.assertTrue(parsed['valid'])
        self.assertEqual(parsed['value']['observations'][0]['files_modified'],['src/queue.ts'])
        self.assertNotIn('invented.ts',str(parsed['value']))

    def test_count_and_grouping_split(self):
        c=self.cases[0]
        self.assertEqual(len(Observation().build_requests([c],{'maxItems':1})),2)
        c['records'][1]['prompt_number']=2
        self.assertEqual(len(Observation().build_requests([c],{})),2)

    def test_over_budget_is_input_failure(self):
        case={**self.cases[0],'records':[{'tool_name':'Edit','tool_input':{'content':'x'*90000},'tool_output':'changed'}]}
        with self.assertRaisesRegex(ValueError,'over_budget'):
            Observation().build_requests([case],{})

    def test_summary_context_kind_and_skip(self):
        case=next(c for c in self.cases if c['kind']=='summary')
        request=Summary().build_requests([case],{})[0]
        self.assertIn('Persisted observations',request['query'])
        self.assertTrue(Summary().parse_response(request,SUMMARY)['valid'])
        self.assertFalse(Summary().parse_response(request,XML)['valid'])
        self.assertTrue(Summary().parse_response(request,'<skip_summary reason="noise"/>')['valid'])

    def test_infrastructure_vs_known_invalid_output(self):
        adapter=Observation()
        engine.freeze(adapter,[self.cases[0]],self.root/'dataset.json',scope='synthetic')
        engine.plan(adapter,self.root/'dataset.json',[{'id':'fake','executor':'mock','model':'NO_REAL_MODEL_CALLED'}],self.root/'plan.json',max_calls=2)
        run=self.root/'run';engine.prepare(self.root/'plan.json',run)
        self.assertEqual(engine.score(adapter,run)['candidates']['fake']['execution'],'infrastructure_blocked')
        p=read(run/'plan.json')
        engine.execute(adapter,run,authorization='offline mock only',mock_responses={j['id']:{'text':'invalid'} for j in p['jobs']})
        after=engine.score(adapter,run)['candidates']['fake']
        self.assertEqual(after['execution'],'complete')
        self.assertFalse(after['cases'][0]['aggregate']['valid'])

    def test_uncalibrated_policy_cannot_claim_production(self):
        self.assertFalse(Observation().describe()['policy']['calibrated'])
        self.assertFalse(Summary().describe()['policy']['calibrated'])

if __name__=='__main__': unittest.main()

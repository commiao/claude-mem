"""Business adapter contracts; no model or production database access."""
import copy
import json
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

    def test_six_cases_including_twenty_records_cross_pipe_capacity(self):
        cases=[copy.deepcopy(c) for c in self.cases if c['kind']=='observation']
        batch=copy.deepcopy(cases[0]);batch['id']='synthetic-batch20'
        batch['records']=[{'tool_name':'Read','tool_input':{'file_path':'config/synthetic.json'},
            'tool_output':'Synthetic: worker.max_batch_items=20; maxBytes=64000.'} for _ in range(20)]
        cases.append(batch)
        requests=Observation().build_requests(cases,{})
        self.assertGreater(len(json.dumps(requests,ensure_ascii=False).encode()),65536)
        self.assertEqual(len(requests),6)
        self.assertEqual({r['case_ids'][0] for r in requests},{c['id'] for c in cases})
        self.assertEqual(len(next(r for r in requests if r['case_ids']==['synthetic-batch20'])['records']),20)

    def test_large_parser_response_is_complete(self):
        request=Observation().build_requests([self.cases[0]],{})[0]
        fact='Unicode 完整性🙂 ' * 10000
        text='<observation><type>bugfix</type><title>Large</title><facts><fact>'+fact+'</fact></facts></observation>'
        parsed=Observation().parse_response(request,text)
        self.assertTrue(parsed['valid'])
        self.assertEqual(parsed['value']['observations'][0]['facts'],[fact.strip()])

    def test_character_denominator_includes_frozen_context_excludes_gold(self):
        for adapter in [Observation(),Summary()]:
            case=copy.deepcopy(next(c for c in self.cases if c['kind']==adapter.kind))
            case['context']={'project_note':'中文🙂'}
            aggregate={'valid':True,'value':[{'observations':[],'summary':None,'skipped':True}]}
            metrics=adapter.evaluate_case(case,aggregate)
            source=json.dumps(adapter.character_source(case),ensure_ascii=False)
            self.assertEqual(metrics['source_characters'],len(source))
            self.assertNotEqual(metrics['source_characters'],len(source.encode()))
            self.assertEqual(metrics['character_ratio'],metrics['knowledge_characters']/len(source))
            case['expected']={'required_facts':[{'anchors':['gold'*100]}]}
            self.assertEqual(adapter.evaluate_case(case,aggregate)['source_characters'],len(source))
            case['persisted_observations']=[{'facts':['more historical context']}]
            self.assertEqual(adapter.evaluate_case(case,aggregate)['source_characters'],
                len(json.dumps(adapter.character_source(case),ensure_ascii=False)))
            case['request']={'system':'frozen system','messages':[{'content':'full context'}]}
            self.assertEqual(adapter.evaluate_case(case,aggregate)['source_characters'],
                len(json.dumps(adapter.character_source(case),ensure_ascii=False)))
            self.assertEqual(adapter.describe()['policy_version'],'mem-unvalidated-2')

    def test_captured_ab_requests_share_factual_source_without_prompt_variant_leakage(self):
        from llm_eval.evidence import digest
        left=copy.deepcopy(self.cases[0])
        left['request']={'system':'BASELINE_PRIVATE_PROMPT','messages':[{'content':'BASELINE_WRAPPER'}]}
        right=copy.deepcopy(left)
        right['request']={'system':'CANDIDATE_DIFFERENT_PRIVATE_PROMPT','messages':[{'content':'CANDIDATE_WRAPPER'}]}
        adapter=Observation()
        self.assertEqual(adapter.review_source(left),adapter.review_source(right))
        self.assertEqual(digest(adapter.review_source(left)),digest(adapter.review_source(right)))
        self.assertNotIn('PRIVATE_PROMPT',json.dumps(adapter.review_source(left)))
        self.assertNotIn('WRAPPER',json.dumps(adapter.review_source(right)))
        self.assertEqual(adapter.review_source(left)['records'],left['records'])
        aggregate={'valid':True,'value':[{'observations':[],'summary':None,'skipped':True}]}
        # Character metrics keep the old independent field algorithm, including
        # captured request; anonymizing review context must not rewrite it.
        expected={k:left[k] for k in ('user_prompt','records','request','last_assistant_message','persisted_observations','context') if k in left}
        self.assertEqual(adapter.evaluate_case(left,aggregate)['source_characters'],len(json.dumps(expected,ensure_ascii=False)))
        self.assertNotEqual(adapter.evaluate_case(left,aggregate)['source_characters'],
                            adapter.evaluate_case(right,aggregate)['source_characters'])
        historical={'kind':'observation','request':left['request']}
        self.assertEqual(adapter.review_source(historical),{'request':left['request']})

if __name__=='__main__': unittest.main()

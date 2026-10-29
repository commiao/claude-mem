import importlib.util
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('candidate_observation_triage',ROOT/'adapters/evaluation/src/claude_mem_eval/triage.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class ObservationTriageTest(unittest.TestCase):
    def case(self):
        return {'id':'one','kind':'observation_triage',
                'observation':{'title':'Root cause','facts':['Key omitted facts'],'narrative':None},
                'source_records':[{'tool_name':'Read','tool_input':{},'tool_response':'Source code'}],
                'expected':{'value':'valuable','rationale':'GOLD_DO_NOT_SEND'},'eligible_after_memcheck':True}

    def response(self, label='low', confidence=.95):
        return json.dumps({'answers':{k:{'type':'choice','choice':label if k=='value' else next(iter(q['criteria'])),
                                         'confidence':confidence} for k,q in module.QUESTIONS.items()}})

    def test_packets_have_no_gold_or_persistence_labels(self):
        adapter=module.ObservationTriage();case=self.case();adapter.validate_case(case)
        request=adapter.build_requests([case],{})[0]
        self.assertNotIn('GOLD_DO_NOT_SEND',request['query'])
        self.assertNotIn('eligible_after_memcheck',request['query'])
        self.assertEqual(request['body']['business_key'],'kg_hub.obs_triage')
        self.assertEqual(len(json.loads(request['query'])['questions']),3)

    def test_long_sources_are_explicitly_truncated_and_bounded(self):
        case=self.case();case['source_records'][0]['tool_response']='中文 facts '*10000
        request=module.ObservationTriage().build_requests([case],{})[0]
        self.assertTrue(request['source_truncated'])
        self.assertLess(len(request['query']),20000)
        self.assertLess(len(json.dumps(request['body'],ensure_ascii=False).encode()),65536)
        self.assertEqual(json.loads(request['query'])['state']['observation'],case['observation'])

    def test_only_high_confidence_low_none_would_drop(self):
        adapter=module.ObservationTriage();request=adapter.build_requests([self.case()],{})[0]
        self.assertTrue(adapter.parse_response(request,self.response())['value']['would_drop'])
        self.assertFalse(adapter.parse_response(request,self.response(confidence=.7))['value']['would_drop'])
        self.assertFalse(adapter.parse_response(request,self.response(label='valuable'))['value']['would_drop'])
        self.assertFalse(adapter.parse_response(request,self.response(label='unknown'))['value']['would_drop'])
        self.assertFalse(adapter.parse_response(request,self.response(confidence=None))['value']['would_drop'])

    def test_route_budget_counts_nested_json_escaping(self):
        body={'messages':[{'role':'user','content':'"'*11000}]}
        self.assertLess(len(body['messages'][0]['content']),20000)
        self.assertFalse(module.within_route_budget(body))
        body['messages'][0]['content']='中'*19000
        self.assertTrue(module.within_route_budget(body))
        body['messages'][0]['content']='中'*19970
        self.assertEqual(len(json.dumps(body['messages'],ensure_ascii=False,separators=(',',':'))),20000)
        self.assertTrue(module.within_route_budget(body))
        body['messages'][0]['content']+='中'
        self.assertEqual(len(json.dumps(body['messages'],ensure_ascii=False,separators=(',',':'))),20001)
        self.assertFalse(module.within_route_budget(body))

    def test_escaped_sources_fail_during_packet_build(self):
        case=self.case();case['source_records'][0]['tool_response']='"\\'*2000
        with self.assertRaisesRegex(ValueError,'input budget exceeded'):
            module.ObservationTriage().build_requests([case],{})

    def test_wire_limit_also_covers_gateway_reserialization(self):
        body={'business_key':'kg_hub.obs_triage','messages':[{'role':'user','content':'🙂'*16000}]}
        compact=lambda:len(json.dumps(body,ensure_ascii=False,separators=(',',':')).encode())
        body['messages'][0]['content']+='a'*(65536-compact())
        self.assertEqual(compact(),65536)
        self.assertLess(len(json.dumps(body['messages'],ensure_ascii=False,separators=(',',':'))),20000)
        self.assertGreater(len(json.dumps(body,ensure_ascii=False).encode()),65536)
        self.assertFalse(module.within_route_budget(body))

    def test_invalid_shapes_and_probabilities_never_become_a_drop(self):
        adapter=module.ObservationTriage();request=adapter.build_requests([self.case()],{})[0]
        for text in ['{}','not json',self.response(confidence=2),self.response(label='invented')]:
            self.assertFalse(adapter.parse_response(request,text)['valid'])
        value=json.loads(self.response());value['answers']['value']['probabilities']={'none':float('nan')}
        self.assertFalse(adapter.parse_response(request,json.dumps(value))['valid'])

    def test_unknown_fact_labels_are_excluded_from_contradiction_recall(self):
        adapter=module.ObservationTriage();case=self.case();case['expected']['fact_support']='unknown'
        request=adapter.build_requests([case],{})[0]
        parsed=adapter.parse_response(request,self.response(label='valuable'))
        metrics=adapter.evaluate_case(case,adapter.aggregate_case(case,[parsed]))
        self.assertFalse(metrics['known_contradiction'])
        summary=adapter.summarize_score({}, {'candidates':{'one':{'cases':[{'complete':True,'metrics':metrics}]}}})
        self.assertIsNone(summary['candidates']['one']['known_contradiction_recall']['rate'])
        self.assertFalse(summary['production_allowed'])

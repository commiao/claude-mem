import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error

from llm_eval.evidence import write_sealed

ROOT=Path(__file__).resolve().parents[2]
package=types.ModuleType('candidate_mem_triage');package.__path__=[str(ROOT/'adapters/evaluation/src/claude_mem_eval')]
sys.modules['candidate_mem_triage']=package
spec=importlib.util.spec_from_file_location('candidate_mem_triage.triage_transport',Path(package.__path__[0])/'triage_transport.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class TriageTransportTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.run=self.root/'run';self.run.mkdir()
        self.plan={'sha256':'plan-sha','repeat':1,'recovery_calls':0,'candidates':[{'executor':'manual'}],
                   'jobs':[{'id':'job-%02d'%i,'request_sha256':'request-'+str(i),'request':{'body':{
                       'business_key':'kg_hub.obs_triage','messages':[{'role':'user','content':'{}'}]}}} for i in range(33)]}
        self.auth=self.root/'authorization.json'
        write_sealed(self.auth,{'business_key':'kg_hub.obs_triage','plan_sha256':'plan-sha','max_calls':33,
                               'generation_calls':0,'probes':0,'automatic_retries':0,'user_authorization':'fixed user budget'})

    def test_429_is_one_attempt_no_probe_no_retry_and_no_quality_import(self):
        outer=self
        class Opener:
            calls=0
            def open(self,request,timeout):
                self.calls+=1
                ledger=outer.run/'business-transport/calls.jsonl'
                outer.assertEqual(json.loads(ledger.read_text().splitlines()[0])['state'],'started')
                raise urllib.error.HTTPError(request.full_url,429,'limited',{},io.BytesIO(b'{"error":"limited"}'))
        opener=Opener()
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module.engine,'import_results') as imported,patch.object(module.time,'sleep'):
            result=module.execute(self.run,self.auth,'http://127.0.0.1:39002',lambda:'test-only',opener=opener)
            self.assertEqual(result['started'],1);self.assertEqual(result['not_attempted'],32)
            self.assertEqual(result['stopped_reason'],'http_429');self.assertEqual(opener.calls,1)
            imported.assert_not_called()
            with self.assertRaisesRegex(ValueError,'already_attempted'):
                module.execute(self.run,self.auth,'http://127.0.0.1:39002',lambda:'test-only',opener=opener)
            self.assertEqual(opener.calls,1)

    def test_transport_timeout_is_unknown_and_never_replayed(self):
        class Opener:
            def open(self,*args,**kwargs):raise TimeoutError('timeout')
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module.time,'sleep'):
            result=module.execute(self.run,self.auth,'http://127.0.0.1:39002',lambda:'test-only',opener=Opener())
        self.assertEqual(result['started'],1);self.assertEqual(result['stopped_reason'],'unknown_transport_outcome')
        self.assertEqual(result['imported'],0)

    def test_wrong_plan_stops_before_credentials_or_network(self):
        self.plan['sha256']='different'
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module,'caller_token') as token:
            with self.assertRaisesRegex(ValueError,'authorization_required'):
                module.execute(self.run,self.auth,'http://127.0.0.1:39002',token)
            token.assert_not_called()

    def test_success_imports_exact_reply_under_shared_manual_evidence(self):
        text='{"answers":{"value":{"choice":"valuable"}}}'
        class Response:
            status=200
            def read(self):return json.dumps({'output':{'content':text},'usage':{'input_tokens':10,'output_tokens':0}}).encode()
            def __enter__(self):return self
            def __exit__(self,*args):pass
        class Opener:
            def open(self,*args,**kwargs):return Response()
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module.engine,'import_results') as imported,patch.object(module.time,'sleep'):
            result=module.execute(self.run,self.auth,'http://127.0.0.1:39002',lambda:'test-only',opener=Opener())
        self.assertEqual(result['started'],33);self.assertEqual(result['imported'],33)
        self.assertEqual(imported.call_args_list[0].args[2][0]['text'],text)
        self.assertNotIn('test-only',(self.run/'business-transport/calls.jsonl').read_text())

    def test_any_escaped_packet_over_budget_stops_entire_cohort_before_credentials(self):
        self.plan['jobs'][23]['request']['body']['messages'][0]['content']='"'*11000
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module,'caller_token') as token:
            with self.assertRaisesRegex(ValueError,'wire_budget'):
                module.execute(self.run,self.auth,'http://127.0.0.1:39002',token)
            token.assert_not_called()
        self.assertFalse((self.run/'business-transport/calls.jsonl').exists())

    def test_v2_needs_new_scenario_bound_authorization(self):
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module,'caller_token') as token:
            with self.assertRaisesRegex(ValueError,'v2_authorization'):
                module.execute(self.run,self.auth,'http://127.0.0.1:39002',token,scenario='claude_mem.observation_triage_v2')
            token.assert_not_called()

    def test_v2_all_local_decisions_need_no_credentials_or_http(self):
        auth=self.root/'v2-authorization.json'
        write_sealed(auth,{'business_key':'kg_hub.obs_triage','plan_sha256':'plan-sha','max_calls':33,
            'generation_calls':0,'probes':0,'automatic_retries':0,'user_authorization':'new explicit test-only budget',
            'scenario':'claude_mem.observation_triage_v2'})
        for job in self.plan['jobs']:
            job['request']={'execution':'local','body':None,'local_action':'review','local_reason':'exact_match_history_unverified'}
        with patch.object(module.engine,'load_run',return_value=self.plan),patch.object(module.engine,'import_results') as imported,patch.object(module,'caller_token') as token:
            result=module.execute(self.run,auth,'http://127.0.0.1:39002',token,scenario='claude_mem.observation_triage_v2')
            token.assert_not_called()
        self.assertEqual(result['started'],0);self.assertEqual(result['local_decisions'],33)
        self.assertEqual(result['imported_judge'],0);self.assertEqual(result['not_attempted'],0)
        self.assertEqual(imported.call_count,33)
        row=imported.call_args_list[0].args[2][0]
        self.assertEqual(json.loads(row['text'])['deterministic_action'],'review')
        self.assertEqual(row['stop'],'local_deterministic')

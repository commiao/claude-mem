import copy
import importlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from llm_eval.evidence import digest

ROOT=Path(__file__).resolve().parents[2]
PACKAGE='candidate_atomic_triage'
pkg=types.ModuleType(PACKAGE);pkg.__path__=[str(ROOT/'adapters/evaluation/src/claude_mem_eval')];sys.modules[PACKAGE]=pkg
v2=importlib.import_module(PACKAGE+'.triage_v2');ctx=importlib.import_module(PACKAGE+'.triage_context')


def case():
    row={'id':1,'project':'one','created_at_epoch':100,'title':'Old root cause','subtitle':None,'facts':['Earlier finding'],'narrative':'Earlier cause'}
    value={'id':'one','kind':'observation_triage_v2','project':'one','cutoff_epoch':1000,
           'observation':{'title':'Root cause','facts':['New distinct fact'],'narrative':'A useful mechanism'},
           'source_records':[{'tool_name':'Read','tool_input':{'path':'file'},'tool_response':'A useful mechanism. New distinct fact.'}],
           'expected':{'value':'valuable','fact_support':'unknown','rationale':'GOLD_DO_NOT_SEND'},'eligible_after_memcheck':True}
    value['memory_context']={'schema_version':1,'project':'one','cutoff_epoch':1000,'captured_at_epoch':500,
        'observation_sha256':digest(ctx.observation(value['observation'])),'candidates':[row],
        'candidates_sha256':digest([row]),'complete':False,'content_time_verified':True,'read_mode':'immutable-precutoff-snapshot'}
    value['memory_context']['excluded_ids_sha256']=digest([])
    return value


def response(durable=.99,novelty='adds_information',support='supported',confidence=.99):
    answers={'durable':{'type':'noul','noul':durable}}
    for key,choice in [('novelty',novelty),('support',support)]:
        probs={k:.005 for k in v2.QUESTIONS[key]['criteria']};probs[choice]=.99
        answers[key]={'type':'choice','choice':choice,'confidence':confidence,'probabilities':probs}
    return json.dumps({'answers':answers})


class AtomicTriageTests(unittest.TestCase):
    def setUp(self):self.adapter=v2.ObservationTriageV2()

    def decide(self,c=None,**kwargs):
        c=c or case();request=self.adapter.build_requests([c],{})[0]
        return self.adapter.parse_response(request,response(**kwargs))['value']

    def test_all_three_dimensions_change_actions_and_unknown_is_review(self):
        self.assertEqual(self.decide()['action'],'keep')
        self.assertEqual(self.decide(durable=.01)['action'],'drop')
        self.assertEqual(self.decide(novelty='already_captured')['reason'],'duplicate')
        for key,val in [('novelty','insufficient'),('support','insufficient'),('support','contradicted')]:
            self.assertEqual(self.decide(**{key:val})['action'],'review')
        self.assertEqual(self.decide(confidence=.6)['action'],'review')
        # Low utility does not silently overrule source conflict.
        self.assertEqual(self.decide(durable=.01,support='contradicted')['action'],'review')

    def test_noul_probability_is_not_choice_confidence(self):
        self.assertEqual(v2.QUESTIONS['durable']['type'],'noul')
        self.assertEqual(self.decide(durable=.89)['action'],'review')
        self.assertEqual(self.decide(durable=.11)['action'],'review')
        self.assertEqual(self.decide(durable=.1)['action'],'drop')
        self.assertEqual(self.decide(durable=.9)['action'],'keep')
        for bad in [True,float('nan'),float('inf'),-.1,1.1,'0.9']:
            request=self.adapter.build_requests([case()],{})[0]
            self.assertFalse(self.adapter.parse_response(request,response(durable=bad))['valid'])

    def test_labels_and_extra_fields_never_enter_requests(self):
        c=case();c['observation']['reviewer_note']='GOLD_OBSERVATION'
        c['source_records'][0]['expected']='GOLD_SOURCE';c['memory_context']['candidates'][0]['label']='GOLD_MEMORY'
        c['memory_context']['candidates_sha256']=digest(c['memory_context']['candidates'])
        r=self.adapter.build_requests([c],{})[0]
        for word in ['GOLD_','eligible_after_memcheck','expected']:
            self.assertNotIn(word,r['query'])
        state=json.loads(r['query'])['state']
        self.assertIsInstance(state['sources'],list);self.assertNotIn('source_records_json',state)
        self.assertEqual(set(state),{'observation','sources','memory'})
        self.assertNotIn('source_sha256',r['query'])
        for displayed,receipt in zip(state['sources'],r['evidence_receipt']['sources']):
            for field in ('tool_input','tool_response'):
                self.assertEqual(displayed[field],[s['text'] for s in receipt[field]])

    def test_snapshot_is_bound_to_observation_project_and_time(self):
        for field,value in [('project','another'),('cutoff_epoch',999),('observation_sha256','changed'),('candidates_sha256','changed')]:
            c=case();c['memory_context'][field]=value
            with self.assertRaisesRegex(ValueError,'binding'):self.adapter.build_requests([c],{})
        for field,value in [('project','another'),('created_at_epoch',1000),('created_at_epoch',501)]:
            c=case();c['memory_context']['candidates'][0][field]=value
            c['memory_context']['candidates_sha256']=digest(c['memory_context']['candidates'])
            with self.assertRaisesRegex(ValueError,'future'):self.adapter.build_requests([c],{})
        c=case();c['memory_context']['captured_at_epoch']=1001
        with self.assertRaisesRegex(ValueError,'not verified'):self.adapter.build_requests([c],{})

    def test_no_candidates_or_unverified_history_cannot_prove_novelty(self):
        c=case();c['memory_context']['candidates']=[];c['memory_context']['candidates_sha256']=digest([])
        self.assertEqual(self.decide(c)['action'],'review')
        c=case();c['memory_context']['content_time_verified']=False
        for novelty in ['adds_information','already_captured']:
            self.assertEqual(self.decide(c,novelty=novelty)['action'],'review')

    def test_exact_body_duplicate_uses_local_receipt_but_title_alone_does_not(self):
        c=case();row=c['memory_context']['candidates'][0]
        row.update(c['observation']);c['memory_context']['candidates_sha256']=digest([row])
        r=self.adapter.build_requests([c],{})[0]
        self.assertEqual(r['execution'],'local');self.assertIsNone(r['body'])
        result=self.adapter.parse_response(r,json.dumps({'deterministic_action':'drop','reason':'exact_duplicate'}))
        self.assertTrue(result['valid']);self.assertEqual(result['value']['origin'],'deterministic')
        self.assertFalse(self.adapter.parse_response(r,response())['valid'])
        c['memory_context']['content_time_verified']=False
        self.assertEqual(self.adapter.build_requests([c],{})[0]['local_action'],'review')
        row['facts']=['Different fact'];c['memory_context']['candidates_sha256']=digest([row])
        self.assertEqual(self.adapter.build_requests([c],{})[0]['execution'],'judge')
        self.assertIsNone(ctx.body_key({'title':'only a title'}))

    def test_relevant_middle_source_is_selected_and_offsets_are_exact(self):
        text=('unrelated line\n'*500)+'unique rooted mechanism\n'+('other unrelated line\n'*500)
        spans,omitted=ctx.evidence_windows(text,ctx.tokens('unique rooted mechanism'),600)
        self.assertTrue(omitted);self.assertTrue(any('unique rooted mechanism' in p['text'] for p in spans))
        for p in spans:self.assertEqual(text[p['start']:p['end']],p['text'])
        self.assertLessEqual(sum(len(p['text']) for p in spans),600)
        c=case();c['source_records'][0]['tool_response']=text
        r=self.adapter.build_requests([c],{})[0]
        self.assertTrue(r['source_omitted'])
        self.assertEqual(self.adapter.parse_response(r,response())['value']['action'],'review')

    def test_heavily_escaped_input_is_bounded_without_truncating_observation(self):
        c=case();c['source_records'][0]['tool_response']='"\\'*20000
        r=self.adapter.build_requests([c],{})[0]
        self.assertTrue(v2.within_route_budget(r['body']))
        self.assertEqual(json.loads(r['query'])['state']['observation'],ctx.observation(c['observation']))
        self.assertLessEqual(r['input_characters'],20000);self.assertLessEqual(r['wire_bytes'],65536)
        c['observation']['narrative']='"'*40000
        c['memory_context']['observation_sha256']=digest(ctx.observation(c['observation']))
        with self.assertRaisesRegex(ValueError,'cannot fit'):self.adapter.build_requests([c],{})

    def test_choices_require_complete_valid_probabilities_and_argmax(self):
        r=self.adapter.build_requests([case()],{})[0]
        for mutate in [lambda a:a['support'].pop('confidence'),lambda a:a['support'].pop('probabilities'),
                       lambda a:a['support'].update(choice='contradicted'),lambda a:a.pop('novelty')]:
            raw=json.loads(response());mutate(raw['answers'])
            self.assertFalse(self.adapter.parse_response(r,json.dumps(raw))['valid'])
        legacy={'answers':{'value':{'type':'choice','choice':'valuable'},'novelty':{},'support':{}}}
        self.assertFalse(self.adapter.parse_response(r,json.dumps(legacy))['valid'])

    def test_reviews_are_not_counted_as_passes_or_drops(self):
        c=case();p=self.adapter.parse_response(self.adapter.build_requests([c],{})[0],response(support='insufficient'))
        metrics=self.adapter.evaluate_case(c,self.adapter.aggregate_case(c,[p]))
        detail=self.adapter.summarize_score({}, {'candidates':{'one':{'cases':[{'complete':True,'metrics':metrics}]}}})
        d=detail['candidates']['one']
        self.assertEqual(d['actions'],{'review':1});self.assertEqual(d['valuable_false_rejection']['numerator'],0)
        self.assertEqual(d['review_rate']['numerator'],1);self.assertIsNone(d['known_contradiction_recall']['rate'])
        self.assertFalse(detail['production_allowed'])


class MemorySnapshotTests(unittest.TestCase):
    def test_schema_keys_do_not_create_fake_similarity(self):
        self.assertEqual(ctx.overlap(ctx.tokens({'facts':['alpha']}),{'facts':['beta']}),0)

    def test_readonly_scope_time_candidates_and_older_exact_match(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'memory.db';db=sqlite3.connect(path)
            db.execute('CREATE TABLE observations(id INTEGER PRIMARY KEY,project,title,subtitle,facts,narrative,created_at_epoch INTEGER)')
            c=case();obs=c['observation']
            db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?)',(1,'one',obs['title'],None,json.dumps(obs['facts']),obs['narrative'],10))
            for i in range(2,12):db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?)',(i,'one','unrelated',None,'[]','other',100+i))
            db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?)',(20,'another',obs['title'],None,json.dumps(obs['facts']),obs['narrative'],20))
            db.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?)',(21,'one',obs['title'],None,json.dumps(obs['facts']),obs['narrative'],1000))
            db.commit();db.close();before=path.read_bytes()
            snapshot=ctx.freeze_memory(path,c,pool_limit=2,top_k=3)
            self.assertEqual(path.read_bytes(),before)
            self.assertEqual(snapshot['candidates'][0]['id'],1)
            self.assertTrue(all(r['project']=='one' and r['created_at_epoch']<1000 for r in snapshot['candidates']))
            self.assertLessEqual(len(snapshot['candidates']),3);self.assertFalse(snapshot['content_time_verified'])
            self.assertFalse(snapshot['complete'])
            c['memory_context']=snapshot
            self.assertEqual(v2.ObservationTriageV2().build_requests([c],{})[0]['local_action'],'review')
            c['excluded_memory_ids']=[1]
            snapshot=ctx.freeze_memory(path,c,pool_limit=2,top_k=3)
            self.assertNotIn(1,[r['id'] for r in snapshot['candidates']])
            c['memory_context']=snapshot
            v2.ObservationTriageV2().validate_case(c)
            snapshot['candidates'].append({'id':1,'project':'one','created_at_epoch':10})
            snapshot['candidates_sha256']=digest(snapshot['candidates'])
            with self.assertRaisesRegex(ValueError,'out-of-scope'):
                v2.ObservationTriageV2().validate_case(c)

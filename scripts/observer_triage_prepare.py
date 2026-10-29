#!/usr/bin/env python3
"""Prepare atomic triage cases and scoped memory snapshots; no model calls."""
import argparse
import json
from pathlib import Path
from llm_eval.evidence import digest, write_sealed
from claude_mem_eval.triage_context import freeze_memory
from claude_mem_eval.triage_v2 import ObservationTriageV2


def prepare(cases, sources, persistence, database, out):
    original={c['id']:c for c in sources};result=[]
    if {r['case_id'] for r in persistence} != set(original):
        raise ValueError('persistence/source cohort mismatch')
    excluded=sorted({ident for r in persistence for t in r['tasks'] for ident in (t.get('outcome') or {}).get('observationIds',[])})
    for old in cases:
        source=original[old['source']['original_case_id']]
        epochs=[r['enqueued_at_epoch'] for r in source['records'] if type(r.get('enqueued_at_epoch')) is int]
        if len(epochs)!=len(source['records']):raise ValueError('original source event times required')
        case={**old,'kind':'observation_triage_v2','project':source['project'],
              'cutoff_epoch':min(epochs),'excluded_memory_ids':excluded}
        case['memory_context']=freeze_memory(database,case)
        result.append(case)
    adapter=ObservationTriageV2()
    requests=adapter.build_requests(result,{})
    directory=Path(out);directory.mkdir(parents=True,exist_ok=False)
    (directory/'cases.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    (directory/'requests.json').write_text(json.dumps(requests,ensure_ascii=False,indent=2)+'\n')
    return write_sealed(directory/'preparation.json',{'type':'atomic-triage-preparation','cases':len(result),
        'cases_sha256':digest(result),'requests_sha256':digest(requests),'model_calls':0,'database_writes':0,
        'planned_judge_packets':sum(r['execution']=='judge' for r in requests),
        'local_decisions':sum(r['execution']=='local' for r in requests),
        'input_characters':sum(r['input_characters'] for r in requests),
        'wire_bytes':sum(r['wire_bytes'] for r in requests),'characters_are_not_tokens':True,
        'memory_candidates':sum(len(c['memory_context']['candidates']) for c in result),
        'historical_contents_verified':False,'production_allowed':False})


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('cases','sources','persistence','database','out'):p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args()
    summary=prepare(json.loads(a.cases.read_text()),json.loads(a.sources.read_text()),json.loads(a.persistence.read_text()),a.database,a.out)
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__':main()

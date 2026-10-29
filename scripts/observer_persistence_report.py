#!/usr/bin/env python3
"""Use installed MemCheck label/receipt validation and metrics for SQLite replay.

Run with the active bundle's Python. This is orchestration, not another evaluator:
labels are frozen, the packaged validator checks their original source/output
bindings, and the packaged calculator computes all three metric columns.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import sqlite3

from llm_eval.evidence import digest, verify
from claude_mem_eval import Observation
from claude_mem_eval.filter_metrics import review_targets, _review_labels
from claude_mem_eval.filter_persistence import validate_receipt
from claude_mem_eval.filter_quality import aggregate


def load(path):
    return json.loads(path.read_text())


def report(evidence, replay_dir, annotations_path):
    plan = load(evidence / 'plan.json')
    scored = load(evidence / 'score-unlabelled.json')
    annotations = load(annotations_path)
    for document in (plan, scored, annotations):
        verify(document)
    adapter = Observation()
    cases, sources, targets = review_targets(adapter, plan, scored)
    labels, output_labels = _review_labels(plan, sources, targets, scored, annotations)
    verified = validate_receipt(adapter, plan, scored, targets, annotations['persistence_receipt'])
    replay = load(replay_dir / 'replay.json')
    if replay['new_model_calls'] != 0 or replay['production_database_access'] is not False:
        raise ValueError('offline-only replay required')
    for name, expected in replay['sourceHashes'].items():
        if hashlib.sha256((evidence / name).read_bytes()).hexdigest() != expected:
            raise ValueError('frozen source file changed')
    originals = load(evidence / 'cases.json')
    if {c['id']: c for c in originals} != cases:
        raise ValueError('replayed cases differ from the sealed plan')
    jobs = {job['request']['case_ids'][0]: job for job in plan['jobs']}
    if len(jobs) != len(cases):
        raise ValueError('one original job per frozen source case required')
    rows_by_variant = {name: {r['caseId']: r for r in replay[name]['rows']} for name in ('before', 'after')}
    if any(set(rows) != set(cases) for rows in rows_by_variant.values()):
        raise ValueError('replay source coverage changed')

    # Independently re-open both temporary databases read-only; ID claims alone
    # do not prove an insertion. These databases began empty, with no seed rows.
    for name, stem in [('before', 'baseline'), ('after', 'candidate')]:
        seen = set()
        with sqlite3.connect((replay_dir / (stem + '.sqlite3')).resolve().as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            for row in rows_by_variant[name].values():
                inserted = set(row['result']['insertedObservationIds'])
                for output in row['outputs']:
                    for ident in output['persistedIds']:
                        if ident not in inserted:
                            raise ValueError('output ID is not in the insert receipt')
                        record = db.execute('SELECT title,subtitle,narrative,type,facts,concepts,files_read,files_modified '
                                            'FROM observations WHERE id=?', (ident,)).fetchone()
                        observation = output['observation']
                        expected = [observation[k] for k in ('title', 'subtitle', 'narrative', 'type')]
                        if record is None or list(record[:4]) != expected or any(
                            json.loads(record[i + 4]) != observation[k]
                            for i, k in enumerate(('facts', 'concepts', 'files_read', 'files_modified'))
                        ):
                            raise ValueError('temporary SQLite readback differs')
                        seen.add(ident)
            if seen != {r[0] for r in db.execute('SELECT id FROM observations')}:
                raise ValueError('temporary SQLite contains unaccounted rows')

    documents = {name: {'schema_version': 1, 'cases': []} for name in ('historical', 'before', 'after')}
    changes = []
    for ident, case in cases.items():
        job = jobs[ident]
        before, after = (rows_by_variant[name][ident] for name in ('before', 'after'))
        if len(before['outputs']) != len(after['outputs']):
            raise ValueError('generated output identities changed')
        output_rows = {name: [] for name in documents}
        for original, candidate in zip(before['outputs'], after['outputs']):
            index = original['outputIndex']
            key = job['id'], index
            if candidate['outputIndex'] != index or digest(original['observation']) != targets[key]['output_sha256']:
                raise ValueError('baseline replay output differs from reviewed original')
            # Only a missing title may be copied from an existing subtitle.
            old, new = dict(original['observation']), dict(candidate['observation'])
            old_title, new_title = old.pop('title'), new.pop('title')
            if old != new or (old_title and old_title != new_title):
                raise ValueError('label transfer would change the reviewed body')
            label = output_labels.get(key, {})
            base = {'id': job['id'] + '.o' + str(index), 'value': label.get('value', 'unknown'),
                    'fact_support': label.get('fact_support', 'unknown')}
            for name, ids in [('historical', verified[key]['inserted_ids']),
                              ('before', original['persistedIds']), ('after', candidate['persistedIds'])]:
                output_rows[name].append({**base, 'persisted_ids': ids})
            if bool(original['persistedIds']) != bool(candidate['persistedIds']) or candidate['rejection'] or old_title != new_title:
                changes.append({'case_id': ident, 'output_index': index, 'value': base['value'],
                                'reason': candidate['rejection'], 'title_recovered': old_title != new_title,
                                'baseline_inserted': bool(original['persistedIds']),
                                'candidate_inserted': bool(candidate['persistedIds'])})
        for name, document in documents.items():
            document['cases'].append({'id': ident, 'source_task_count': len(case['records']),
                                      'input_value': labels.get(ident, {}).get('input_value', 'unknown'),
                                      # This is the ORIGINAL generation decision. A DB gate
                                      # does not retroactively turn a generated reply into a skip.
                                      'action': before['action'], 'outputs': output_rows[name]})
    metrics = {name: aggregate(document) for name, document in documents.items()}
    for name, document in documents.items():
        (replay_dir / (name + '-metrics-input.json')).write_text(json.dumps(document, ensure_ascii=False, indent=2))
    result = {'scope': 'candidate offline parser/gate/persistence replay; not new generation or production admission',
              'metrics_engine': 'installed claude_mem_eval.filter_quality.aggregate',
              'source_output_label_binding_verified': True, 'temporary_database_readback_verified': True,
              'new_model_calls': 0, 'production_allowed': False, 'independent_review': False,
              'metrics': metrics, 'changes': changes,
              'limitations': ['Historical and controlled replay counts are separate: replay begins with empty temporary SQLite.',
                              'Review labels are unchanged from the prior current-conversation audit; no new judge or independent review.',
                              'Generation noise and known factual errors are not repaired by a persistence gate.',
                              'The installed released bridge is unchanged; this run explicitly tests the candidate source.']}
    (replay_dir / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    columns = [('unique_new', lambda m: m['conversion']['unique_new_observations']),
               ('batch_conversion', lambda m: m['conversion']['batches_with_new_observations']['rate']),
               ('generated_to_inserted', lambda m: m['conversion']['outputs_with_insertions']['rate']),
               ('no_value_contamination', lambda m: m['newly_persisted']['no_value_contamination']['rate']),
               ('low_or_no_value_contamination', lambda m: m['newly_persisted']['low_or_no_value_contamination']['rate']),
               ('valuable_insertions', lambda m: m['newly_persisted']['value_counts'].get('valuable', 0))]
    with (replay_dir / 'comparison.csv').open('w', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['metric', *metrics])
        writer.writerows([key, *(get(m) for m in metrics.values())] for key, get in columns)
    print(json.dumps({'new_model_calls': 0, 'source_cases': len(cases), 'label_binding_verified': True,
                      **{name: m['conversion']['unique_new_observations'] for name, m in metrics.items()}}))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--replay', type=Path, required=True)
    parser.add_argument('--annotations', type=Path, required=True)
    args = parser.parse_args()
    report(args.evidence.resolve(), args.replay.resolve(), args.annotations.resolve())

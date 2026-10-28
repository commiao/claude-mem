#!/usr/bin/env python3
"""Aggregate reviewed filter labels; never call a model or infer semantic labels.

This is a business metric calculator, not a replacement for llm-eval's frozen
datasets, execution, evidence, or independent review. See observer-model-bench.md.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path

VALUES = {'valuable', 'low', 'none', 'unknown'}
SUPPORT = {'supported', 'incorrect', 'unknown'}
ACTIONS = {'generated', 'skip', 'empty'}


def fraction(numerator: int, denominator: int) -> dict:
    return {'numerator': numerator, 'denominator': denominator,
            'rate': numerator / denominator if denominator else None}


def bounds(count: int, unknown: int, total: int) -> dict:
    return {**fraction(count, total), 'unknown': unknown,
            'lower_bound': count / total if total else None,
            'upper_bound': (count + unknown) / total if total else None}


def aggregate(document: dict) -> dict:
    if document.get('schema_version') != 1 or not isinstance(document.get('cases'), list) or not document['cases']:
        raise ValueError('schema_version=1 and nonempty cases required')
    seen_cases, seen_outputs, cases, outputs, inserted, inserted_owner = set(), set(), [], [], {}, {}
    for case in document['cases']:
        ident = case.get('id')
        if not isinstance(ident, str) or not ident or ident in seen_cases:
            raise ValueError('unique nonempty case IDs required')
        seen_cases.add(ident)
        count = case.get('source_task_count')
        if type(count) is not int or count < 1:
            raise ValueError('positive source_task_count required')
        if case.get('input_value') not in VALUES or case.get('action') not in ACTIONS:
            raise ValueError('explicit input_value/action required')
        rows = case.get('outputs')
        if not isinstance(rows, list) or (case['action'] == 'generated') != bool(rows):
            raise ValueError('only generated cases may contain outputs; generated must be nonempty')
        case_inserted = set()
        for row in rows:
            oid = row.get('id')
            if not isinstance(oid, str) or not oid or oid in seen_outputs:
                raise ValueError('globally unique generated output IDs required')
            seen_outputs.add(oid)
            if row.get('value') not in VALUES or row.get('fact_support') not in SUPPORT:
                raise ValueError('explicit output value/fact_support required')
            ids = row.get('persisted_ids')
            if not isinstance(ids, list) or any(type(i) is not int or i < 1 for i in ids):
                raise ValueError('persisted_ids must contain only positive actual newly inserted observation IDs')
            for pid in set(ids):
                if pid in inserted_owner and inserted_owner[pid] != ident:
                    raise ValueError('a newly inserted observation ID cannot belong to multiple source cases')
                inserted_owner[pid] = ident
                item = inserted.setdefault(pid, {'values': set(), 'support': set()})
                item['values'].add(row['value'])
                item['support'].add(row['fact_support'])
                case_inserted.add(pid)
            outputs.append(row)
        cases.append({**case, 'has_insertions': bool(case_inserted)})

    def quality(rows):
        value = Counter(r['value'] for r in rows)
        support = Counter(r['fact_support'] for r in rows)
        total = len(rows)
        return {'count': total, 'value_counts': dict(value), 'fact_support_counts': dict(support),
                'value_review_coverage': fraction(total - value['unknown'], total),
                'fact_support_review_coverage': fraction(total - support['unknown'], total),
                'no_value_contamination': bounds(value['none'], value['unknown'], total),
                'low_value_contamination': bounds(value['low'], value['unknown'], total),
                'low_or_no_value_contamination': bounds(value['none'] + value['low'], value['unknown'], total),
                'incorrect_facts': bounds(support['incorrect'], support['unknown'], total)}

    # A repeated actual memory ID is counted once, including where shared batch
    # outcomes repeat for every input task. Conflicting labels remain unknown.
    unique_rows = [{'value': next(iter(v['values'])) if len(v['values']) == 1 else 'unknown',
                    'fact_support': next(iter(v['support'])) if len(v['support']) == 1 else 'unknown'}
                   for v in inserted.values()]
    none = [c for c in cases if c['input_value'] == 'none']
    valuable = [c for c in cases if c['input_value'] == 'valuable']
    low = [c for c in cases if c['input_value'] == 'low']
    low_or_none = [c for c in cases if c['input_value'] in {'low', 'none'}]
    unknown = [c for c in cases if c['input_value'] == 'unknown']
    matrix = {value: dict(Counter(c['action'] for c in cases if c['input_value'] == value)) for value in sorted(VALUES)}
    generated = sum(c['action'] == 'generated' for c in cases)
    persisted = sum(c['has_insertions'] for c in cases)
    return {'schema_version': 1, 'method': 'aggregation of supplied review labels; no semantic inference',
            'production_allowed': False, 'thresholds_calibrated': False,
            'inputs': {'cases': len(cases), 'source_tasks': sum(c['source_task_count'] for c in cases),
                       'value_action_matrix': matrix, 'value_review_coverage': fraction(len(cases) - len(unknown), len(cases)),
                       'no_value_rejection': fraction(sum(c['action'] == 'skip' for c in none), len(none)),
                       'no_value_generation_leakage': fraction(sum(c['action'] == 'generated' for c in none), len(none)),
                       'no_value_persistence_leakage': fraction(sum(c['has_insertions'] for c in none), len(none)),
                       'valuable_explicit_skip_false_rejection': fraction(sum(c['action'] == 'skip' for c in valuable), len(valuable)),
                       'valuable_no_generation': fraction(sum(c['action'] != 'generated' for c in valuable), len(valuable)),
                       'valuable_without_new_observations': fraction(sum(not c['has_insertions'] for c in valuable), len(valuable)),
                       'low_value_rejection': fraction(sum(c['action'] == 'skip' for c in low), len(low)),
                       'low_or_no_value_rejection': fraction(sum(c['action'] == 'skip' for c in low_or_none), len(low_or_none)),
                       'low_or_no_value_generation_leakage': fraction(sum(c['action'] == 'generated' for c in low_or_none), len(low_or_none)),
                       'low_or_no_value_persistence_leakage': fraction(sum(c['has_insertions'] for c in low_or_none), len(low_or_none)),
                       'unknown_cases': len(unknown),
                       'note': 'input filter rates are conditional on explicitly labeled inputs; unknown cases are excluded and coverage is shown'},
            'conversion': {'generated_batches': fraction(generated, len(cases)),
                           'batches_with_new_observations': fraction(persisted, len(cases)),
                           'generated_observations': len(outputs), 'unique_new_observations': len(inserted),
                           'outputs_with_insertions': fraction(sum(bool(o['persisted_ids']) for o in outputs), len(outputs)),
                           'new_observations_per_source_task': fraction(len(inserted), sum(c['source_task_count'] for c in cases)),
                           'note': 'one source may produce many observations; per-source output count is not a fact-retention probability'},
            'generated': quality(outputs), 'newly_persisted': quality(unique_rows),
            'limitations': ['Labels are supplied by reviewers; this calculator does not validate their semantic correctness.',
                            'Bounds cover unknown labels, not sampling error or population confidence intervals.',
                            'persisted_ids must be actual newly inserted IDs, not merged existing IDs or list positions; each ID must belong to one source case.',
                            'No calibrated production thresholds or model admission are issued.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labels', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = aggregate(json.loads(args.labels.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'out': str(args.out), 'cases': result['inputs']['cases'],
                      'generated': result['generated']['count'], 'newly_persisted': result['newly_persisted']['count']}))


if __name__ == '__main__':
    main()

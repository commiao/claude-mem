"""Output-bound filter review metrics. No semantic guesses and no live DB reads."""
from __future__ import annotations

import hashlib

from llm_eval.evidence import canonical, digest, need
from .filter_quality import aggregate, VALUES, SUPPORT


def raw_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def review_targets(adapter, plan, scored):
    cases = {c['id']: c for c in plan['dataset']['cases']}
    sources = {ident: adapter.review_source(c) for ident, c in cases.items()}
    rows = {}
    for job in plan['jobs']:
        need(len(job['request']['case_ids']) == 1, 'mem filter review needs one source case per request')
        ident = job['request']['case_ids'][0]
        output = scored['outputs'].get(job['id'])
        if not output:
            continue
        observations = (output['parsed'].get('value') or {}).get('observations', [])
        for index, observation in enumerate(observations):
            rows[(job['id'], index)] = {
                'candidate': job['candidate'], 'case_id': ident, 'repetition': job['repetition'],
                'job_id': job['id'], 'output_index': index,
                'source_sha256': digest(sources[ident]), 'raw_sha256': raw_hash(output['raw']),
                'output_sha256': digest(observation), 'observation': observation,
            }
    return cases, sources, rows


def _review_labels(plan, sources, targets, scored, annotations):
    if annotations is None:
        return {}, {}
    need(annotations.get('schema_version') == 1 and annotations.get('type') == 'claude-mem-filter-review',
         'unsupported mem filter review schema')
    need(annotations.get('plan_sha256') == plan['sha256'], 'filter review belongs to another plan')
    reviewer = annotations.get('reviewer', {})
    if annotations.get('cases') or annotations.get('outputs'):
        need(isinstance(reviewer, dict) and reviewer.get('method') in {'human', 'model'}
             and isinstance(reviewer.get('name'), str) and reviewer['name'].strip(), 'named filter reviewer required')
    need('persistence' not in annotations, 'persistence IDs require a separate read-only persistence receipt')
    need(isinstance(annotations.get('cases', []), list) and isinstance(annotations.get('outputs', []), list),
         'filter review cases/outputs must be lists')
    case_labels, output_labels = {}, {}
    for row in annotations.get('cases', []):
        need(isinstance(row, dict), 'filter case review must be an object')
        ident = row.get('case_id')
        need(isinstance(ident, str) and ident in sources and ident not in case_labels, 'unknown or duplicate filter source case')
        need(row.get('source_sha256') == digest(sources[ident]), 'filter source hash mismatch')
        need(row.get('input_value') in VALUES, 'explicit filter input value required')
        if row['input_value'] != 'unknown':
            _quote(row, canonical(sources[ident]))
        need('persisted_ids' not in row, 'review labels cannot assert database insertion')
        case_labels[ident] = row
    for row in annotations.get('outputs', []):
        need(isinstance(row, dict), 'filter output review must be an object')
        key = row.get('job_id'), row.get('output_index')
        need(isinstance(key[0], str) and type(key[1]) is int and key in targets and key not in output_labels,
             'unknown or duplicate filter output reference')
        target = targets[key]
        for name in ('case_id', 'source_sha256', 'raw_sha256', 'output_sha256'):
            need(row.get(name) == target[name], 'filter output binding mismatch: ' + name)
        need(row.get('value') in VALUES and row.get('fact_support') in SUPPORT,
             'explicit output value and fact support required')
        need('persisted_ids' not in row, 'review labels cannot assert database insertion')
        if row['value'] != 'unknown' or row['fact_support'] != 'unknown':
            _quote(row, canonical(sources[target['case_id']]))
            claim = row.get('output_quote')
            need(isinstance(claim, str) and claim.strip() and claim in scored['outputs'][key[0]]['raw'],
                 'exact filter output quote required')
        output_labels[key] = row
    return case_labels, output_labels


def _quote(row, source):
    quote, reason = row.get('source_quote'), row.get('rationale')
    need(isinstance(quote, str) and quote.strip() and quote in source, 'exact filter source quote required')
    need(isinstance(reason, str) and reason.strip(), 'filter review rationale required')


def _source_count(case):
    if case.get('records'):
        return len(case['records'])
    count = case.get('source_task_count')
    need(count is None or (type(count) is int and count > 0), 'invalid frozen source_task_count')
    return count


def _unknown_persistence(result, verified_cases, total_cases):
    """Empty export lists are not proof that an unobserved DB write was zero."""
    if total_cases and verified_cases == total_cases:
        result['persistence'] = {'status': 'verified-frozen-readback', 'verified_cases': verified_cases,
                                 'total_cases': total_cases, 'provider_signature': False}
        return
    result['persistence'] = {'status': 'unknown' if not verified_cases else 'partial',
                             'verified_cases': verified_cases, 'total_cases': total_cases,
                             'note': 'No complete matching read-only persistence receipt; database insertion is not inferred from generation.'}
    for name in ('batches_with_new_observations', 'outputs_with_insertions', 'new_observations_per_source_task'):
        old = result['conversion'][name]
        result['conversion'][name] = {**old, 'numerator': None, 'rate': None}
    result['conversion']['verified_new_observations_lower_bound'] = result['conversion']['unique_new_observations']
    result['conversion']['unique_new_observations'] = None
    for name in ('no_value_persistence_leakage', 'low_or_no_value_persistence_leakage', 'valuable_without_new_observations'):
        old = result['inputs'][name]
        result['inputs'][name] = {**old, 'numerator': None, 'rate': None}
    unknown_rate = {'numerator': None, 'denominator': None, 'rate': None,
                    'unknown': None, 'lower_bound': None, 'upper_bound': None}
    result['newly_persisted'] = {'status': 'unknown', 'count': None,
                                 **{name: dict(unknown_rate) for name in ('no_value_contamination', 'low_value_contamination',
                                     'low_or_no_value_contamination', 'incorrect_facts', 'value_review_coverage', 'fact_support_review_coverage')},
                                 'note': 'Actual new-row count and contamination require complete verified persistence evidence.'}


def summarize(adapter, plan, scored, annotations=None, persistence=None):
    if adapter.kind != 'observation':
        need(annotations is None, 'observation filter annotations cannot be applied to summary scenario')
        need(persistence is None, 'observation persistence cannot be applied to summary scenario')
        return {'schema_version': 1, 'status': 'not-applicable', 'metrics': [],
                'note': 'Summary checkpoint production is evaluated separately from observation filtering.'}
    cases, sources, targets = review_targets(adapter, plan, scored)
    labels, output_labels = _review_labels(plan, sources, targets, scored, annotations)
    verified = {}
    if persistence is not None:
        from .filter_persistence import validate_receipt
        verified = validate_receipt(adapter, plan, scored, targets, persistence)
    candidates, metrics = {}, []
    for cid, candidate in scored['candidates'].items():
        reviewed_cases, verified_count = [], 0
        pending = 0
        for row in candidate['cases']:
            if not row['complete']:
                pending += 1
                continue  # Infrastructure/missing replies are not filter-quality failures.
            ident, repetition = row['id'], row['repetition']
            selected = [target for target in targets.values() if target['case_id'] == ident
                        and target['candidate'] == cid and target['repetition'] == repetition]
            outputs = []
            for target in selected:
                key = target['job_id'], target['output_index']
                label = output_labels.get(key, {})
                outputs.append({'id': target['job_id'] + '.o' + str(target['output_index']),
                                'value': label.get('value', 'unknown'),
                                'fact_support': label.get('fact_support', 'unknown'),
                                'persisted_ids': verified.get(key, {}).get('inserted_ids', [])})
            jobs = row['requests']
            case_verified = bool(jobs) and all((job, None) in verified for job in jobs)
            verified_count += case_verified
            source_count = _source_count(cases[ident])
            if case_verified and len(jobs) == 1:
                readback_count = verified[(jobs[0], None)]['source_tasks']
                need(source_count is None or source_count == readback_count,
                     'frozen source-task count differs from verified batch membership')
                source_count = readback_count
            reviewed_cases.append({'id': ident + '.r' + str(repetition),
                                   'source_task_count': source_count,
                                   'input_value': labels.get(ident, {}).get('input_value', 'unknown'),
                                   'action': 'generated' if outputs else ('skip' if row['metrics'].get('skipped') else 'empty'),
                                   'outputs': outputs})
        result = aggregate({'schema_version': 1, 'cases': reviewed_cases}, allow_empty=True, allow_unknown_sources=True)
        _unknown_persistence(result, verified_count, len(reviewed_cases))
        result['execution_coverage'] = {'completed_case_repetitions': len(reviewed_cases),
                                         'pending_case_repetitions': pending,
                                         'planned_case_repetitions': len(candidate['cases']),
                                         'known_invalid_case_repetitions': sum(row['complete'] and row['aggregate'].get('valid') is False
                                                                              for row in candidate['cases'])}
        if pending:
            # Even a complete receipt for the observed subset is not evidence for pending cases.
            result['persistence']['observed_subset_only'] = True
        candidates[cid] = {'filter_quality': result}
        _metric_rows(cid, result, metrics)
    return {'schema_version': 1, 'method': 'source/output-bound supplied review labels; no semantic inference',
            'production_allowed': False, 'thresholds_calibrated': False,
            'label_evidence': 'operator supplied; independent review identity is not attested',
            'candidates': candidates, 'metrics': metrics,
            'review_targets': {'cases': [{'case_id': ident, 'source_sha256': digest(source),
                                          'source_task_count': _source_count(cases[ident])} for ident, source in sources.items()],
                               'outputs': [{key: value for key, value in target.items() if key != 'observation'}
                                           for target in targets.values()]}}


def _metric_rows(candidate, result, rows):
    """Only the business adapter chooses which named metrics are meaningful."""
    for section in ('inputs', 'conversion', 'generated', 'newly_persisted'):
        for name, value in result[section].items():
            if isinstance(value, dict) and 'rate' in value:
                rows.append({'candidate': candidate, 'name': 'filter_quality.' + section + '.' + name,
                             'unit': 'ratio', **value})
            elif isinstance(value, int) and not isinstance(value, bool):
                rows.append({'candidate': candidate, 'name': 'filter_quality.' + section + '.' + name,
                             'unit': 'count', 'value': value})
            elif value is None and name in {'unique_new_observations', 'count'}:
                rows.append({'candidate': candidate, 'name': 'filter_quality.' + section + '.' + name,
                             'unit': 'count', 'value': None})

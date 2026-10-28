"""Freeze and recheck bounded read-only SQLite persistence evidence for old replies.

This local integrity receipt is neither a provider signature nor a human review.
Fresh model comparisons have no matching historical batch and stay unknown.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3

from llm_eval.evidence import digest, need, now, verify, write_sealed
from .filter_metrics import raw_hash

FIELDS = ('type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified')
ARRAY_FIELDS = {'facts', 'concepts', 'files_read', 'files_modified'}


def _stored(row):
    result = {}
    for field in FIELDS:
        value = row[field]
        result[field] = json.loads(value) if field in ARRAY_FIELDS and value else ([] if field in ARRAY_FIELDS else value)
    return result


def _outcome_ids(tasks):
    all_ids, inserted, merged = set(), set(), set()
    for task in tasks:
        outcome = task['outcome']
        need(task['state'] == 'succeeded' and isinstance(outcome, dict), 'historical source task not succeeded')
        ids, flags, new = (outcome.get(name, []) for name in ('observationIds', 'mergedIntoExisting', 'insertedObservationIds'))
        need(isinstance(ids, list) and isinstance(flags, list) and isinstance(new, list)
             and len(flags) == len(ids) and all(type(x) is int and x > 0 for x in ids + new)
             and all(type(x) is bool for x in flags), 'invalid historical outcome IDs/merge flags')
        need(set(new) <= set(ids), 'inserted IDs outside actual observation IDs')
        all_ids.update(ids)
        inserted.update(new)
        merged.update(ident for ident, flag in zip(ids, flags) if flag)
        need(not set(new) & {ident for ident, flag in zip(ids, flags) if flag}, 'inserted ID cannot be merged existing')
        need(set(ids) == set(new) | {ident for ident, flag in zip(ids, flags) if flag},
             'outcome does not identify whether actual observation IDs were inserted or merged')
    need(not inserted & merged, 'conflicting inserted/merged outcome evidence')
    return all_ids, inserted, merged


def _binding(plan, scored, job, case):
    batch = case.get('source', {}).get('batch_id')
    need(isinstance(batch, str) and batch and isinstance(case.get('request'), dict),
         'persistence receipt requires an original captured source batch')
    need(plan['repeat'] == 1, 'historical persistence receipts require one repetition')
    need(job['request'].get('body') == case['request'], 'historical captured request changed')
    output = scored['outputs'].get(job['id'])
    need(output is not None, 'no returned output for historical persistence readback')
    return {'case_id': case['id'], 'source_batch_id': batch, 'job_id': job['id'],
            'body_sha256': digest(case['request']), 'raw_sha256': raw_hash(output['raw'])}


def export_receipt(adapter, root, database, out):
    from llm_eval.engine import load_run, score
    from .filter_metrics import review_targets
    need(adapter.kind == 'observation', 'only observation persistence can be read back')
    plan, scored = load_run(adapter, root), score(adapter, root)
    cases, sources, targets = review_targets(adapter, plan, scored)
    connection = sqlite3.connect(Path(database).expanduser().resolve().as_uri() + '?mode=ro', uri=True, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute('BEGIN')
    rows = []
    try:
        for job in plan['jobs']:
            need(len(job['request']['case_ids']) == 1, 'ambiguous historical source membership')
            case = cases[job['request']['case_ids'][0]]
            binding = _binding(plan, scored, job, case)
            batch = connection.execute('SELECT body,result,state FROM observer_queue_batches WHERE id=?',
                                       (binding['source_batch_id'],)).fetchone()
            need(batch is not None and batch['state'] == 'succeeded', 'historical batch absent or not succeeded')
            need(json.loads(batch['body']) == case['request'], 'database request does not match frozen source')
            response = json.loads(batch['result'])
            raw = '\n'.join(block['text'] for block in response.get('content', []) if block.get('type') == 'text')
            need(raw_hash(raw) == binding['raw_sha256'], 'database reply does not match the evaluated output')
            tasks = []
            for task in connection.execute('''SELECT t.id,t.state,t.outcome FROM observer_tasks t
                JOIN observer_queue_members m ON m.task_id=t.id WHERE m.batch_id=? ORDER BY t.id''',
                                           (binding['source_batch_id'],)):
                tasks.append({'task_id': task['id'], 'state': task['state'],
                              'outcome': json.loads(task['outcome']) if task['outcome'] else None})
            need(bool(tasks), 'historical batch has no source task outcomes')
            ids, new, merged = _outcome_ids(tasks)
            stored = []
            for ident in sorted(ids):
                record = connection.execute('SELECT * FROM observations WHERE id=?', (ident,)).fetchone()
                if record is not None:
                    normalized = _stored(record)
                    stored.append({'id': ident, 'observation': normalized, 'output_sha256': digest(normalized)})
            outputs = []
            for target in targets.values():
                if target['job_id'] != job['id']:
                    continue
                matched = {row['id'] for row in stored if row['output_sha256'] == target['output_sha256']}
                outputs.append({'output_index': target['output_index'], 'output_sha256': target['output_sha256'],
                                'inserted_ids': sorted(matched & new), 'merged_existing_ids': sorted(matched & merged)})
            matched_new = {ident for row in outputs for ident in row['inserted_ids']}
            matched_any = all(not ids or row['inserted_ids'] or row['merged_existing_ids'] for row in outputs)
            complete = matched_new == new and matched_any and {row['id'] for row in stored} == ids
            rows.append({**binding, 'source_sha256': digest(sources[case['id']]), 'tasks': tasks,
                         'stored_observations': stored, 'outputs': outputs,
                         'complete': complete,
                         'note': None if complete else 'missing or changed rows / normalization mapping; persistence remains unknown'})
    finally:
        connection.close()
    return write_sealed(out, {'schema_version': 1, 'type': 'claude-mem-persistence-readback',
                              'plan_sha256': plan['sha256'], 'adapter': plan['adapter'], 'created_at': now(),
                              'database': {'open_mode': 'ro', 'snapshot': 'read-transaction',
                                           'reference': str(Path(database).expanduser().resolve())},
                              'provider_signature': False, 'rows': rows})


def validate_receipt(adapter, plan, scored, targets, receipt):
    """Check the frozen raw outcomes/readback again; never trust claimed ID lists."""
    verify(receipt)
    need(receipt.get('schema_version') == 1 and receipt.get('type') == 'claude-mem-persistence-readback'
         and receipt.get('plan_sha256') == plan['sha256'] and receipt.get('adapter') == plan['adapter'],
         'persistence receipt plan/adapter mismatch')
    need(receipt.get('database', {}).get('open_mode') == 'ro'
         and receipt['database'].get('snapshot') == 'read-transaction', 'read-only transaction receipt required')
    need(receipt.get('provider_signature') is False, 'local persistence receipts are not provider signatures')
    cases = {c['id']: c for c in plan['dataset']['cases']}
    jobs = {job['id']: job for job in plan['jobs']}
    verified, seen_jobs = {}, set()
    for row in receipt.get('rows', []):
        ident = row.get('job_id')
        need(ident in jobs and ident not in seen_jobs, 'unknown or duplicate persistence job')
        seen_jobs.add(ident)
        job = jobs[ident]
        case = cases[job['request']['case_ids'][0]]
        binding = _binding(plan, scored, job, case)
        binding['source_sha256'] = digest(adapter.review_source(case))
        need(all(row.get(key) == value for key, value in binding.items()), 'persistence source/output binding mismatch')
        tasks = row.get('tasks', [])
        need(isinstance(tasks, list) and tasks and len({t['task_id'] for t in tasks}) == len(tasks),
             'unique historical source task outcomes required')
        ids, new, merged = _outcome_ids(tasks)
        stored = row.get('stored_observations', [])
        need(isinstance(stored, list) and len({r['id'] for r in stored}) == len(stored), 'duplicate stored row IDs')
        for record in stored:
            need(type(record.get('id')) is int and record['id'] in ids
                 and record.get('output_sha256') == digest(record.get('observation')),
                 'persistence readback row/hash mismatch')
        target_rows = {index: target for (job_id, index), target in targets.items() if job_id == ident}
        output_rows = row.get('outputs', [])
        need(isinstance(output_rows, list) and len({r.get('output_index') for r in output_rows}) == len(output_rows)
             and {r.get('output_index') for r in output_rows} == set(target_rows), 'persistence output coverage changed')
        resolved, assigned = {}, set()
        for output in output_rows:
            index = output['output_index']
            need(type(index) is int and output.get('output_sha256') == target_rows[index]['output_sha256'],
                 'persistence normalized output changed')
            matched = {r['id'] for r in stored if r['output_sha256'] == target_rows[index]['output_sha256']}
            expected_new, expected_merged = sorted(matched & new), sorted(matched & merged)
            need(output.get('inserted_ids') == expected_new and output.get('merged_existing_ids') == expected_merged,
                 'persistence inserted IDs do not match frozen outcomes and readback')
            assigned.update(expected_new)
            resolved[(ident, index)] = {'inserted_ids': expected_new, 'merged_existing_ids': expected_merged}
        complete = (assigned == new and {r['id'] for r in stored} == ids
                    and all(not ids or v['inserted_ids'] or v['merged_existing_ids'] for v in resolved.values()))
        need(row.get('complete') is complete, 'persistence completeness claim changed')
        if complete:
            verified.update(resolved)
            verified[(ident, None)] = {'source_tasks': len(tasks)}
    return verified


def main():
    from llm_eval.sdk import load
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    receipt = export_receipt(load('claude_mem.observation'), args.run, args.db, args.out)
    print(json.dumps({'out': str(args.out), 'rows': len(receipt['rows']),
                      'verified_rows': sum(row['complete'] for row in receipt['rows']), 'model_calls': 0}))


if __name__ == '__main__':
    main()

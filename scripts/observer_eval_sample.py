#!/usr/bin/env python3
"""Business-only read-only source export; historical answers are never gold labels."""
import argparse
import collections
import hashlib
import json
import random
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from llm_eval.evidence import digest, need as require, write

def sample_database(db, out, limit, seed, raw_records=False):
    """Bounded, read-only capture of exact production requests; historical outputs are NOT gold labels."""
    require(1 <= limit <= 1000, 'sample limit must be 1..1000')
    connection = sqlite3.connect(Path(db).expanduser().resolve().as_uri() + '?mode=ro', uri=True, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute('BEGIN')  # Keep body, source records and membership in one read-only snapshot.
    try:
        rows = connection.execute('''WITH recent AS (
          SELECT id FROM observer_queue_batches WHERE state IN ('succeeded','failed','reconciliation')
          ORDER BY rowid DESC LIMIT ?)
          SELECT b.id,b.body,b.state,b.session_db_id,MIN(i.kind) kind,MIN(i.context) context,
          COUNT(DISTINCT i.kind) kinds FROM observer_queue_batches b
          JOIN observer_queue_members m ON m.batch_id=b.id JOIN observer_queue_inputs i ON i.task_id=m.task_id
          WHERE b.id IN (SELECT id FROM recent) GROUP BY b.id
          ORDER BY b.created_at DESC''', (min(5000, limit * 10),)).fetchall()
    except BaseException:
        connection.close()
        raise
    groups = collections.defaultdict(list)
    for row in rows:
        if row['kinds'] != 1 or row['kind'] not in ('observation', 'summary'):
            continue
        context = json.loads(row['context'])
        groups[(row['kind'], row['state'], str(context.get('project') or 'unknown'))].append((row, context))
    rng = random.Random(seed)
    for values in groups.values():
        rng.shuffle(values)
    selected = []
    while groups and len(selected) < limit:
        for key in sorted(list(groups)):
            row, context = groups[key].pop()
            selected.append({'id': 'sample-' + hashlib.sha256(row['id'].encode()).hexdigest()[:20],
                'kind': row['kind'], 'category': row['kind'] + '/' + row['state'],
                'project': context.get('project', 'unknown'), 'request': json.loads(row['body']),
                'group_id': 'session-'+str(row['session_db_id']),
                'split': 'holdout' if int(hashlib.sha256(str(row['session_db_id']).encode()).hexdigest(),16)%5==0 else 'dev', 'expected': {},
                'source': {'batch_id': row['id'], 'historical_state': row['state']}})
            if not groups[key]:
                del groups[key]
            if len(selected) == limit:
                break
    try:
        if raw_records:
            for case in selected:
                if case['kind'] != 'observation':
                    continue  # Summary requests retain their original bounded observation context.
                members = connection.execute('''SELECT t.id,t.payload,t.session_db_id,t.content_session_id,t.enqueued_at_epoch,i.context
                  FROM observer_queue_members m JOIN observer_tasks t ON t.id=m.task_id
                  JOIN observer_queue_inputs i ON i.task_id=t.id WHERE m.batch_id=?
                  ORDER BY t.enqueued_at_epoch,t.id''', (case['source']['batch_id'],)).fetchall()
                require(bool(members), 'source membership changed; sample again')
                case['records'] = []
                for member in members:
                    payload = json.loads(member['payload'])
                    case['records'].append({**payload,'task_id':member['id'],'session_db_id':member['session_db_id'],
                        'content_session_id':member['content_session_id'],'context':json.loads(member['context']),
                        'enqueued_at_epoch':member['enqueued_at_epoch'],'tool_name': payload['tool_name'], 'tool_input': payload['tool_input'],
                        'tool_output': payload['tool_response'], 'cwd': payload.get('cwd'),
                        'occurred_at': datetime.fromtimestamp(member['enqueued_at_epoch'] / 1000, timezone.utc).isoformat()})
                contexts = [json.loads(m['context']) for m in members]
                require(all(c == contexts[0] for c in contexts), 'mixed source contexts; sample a different batch')
                case['user_prompt'] = contexts[0].get('userPrompt', '')
                case['source']['original_request_sha256'] = digest(case['request'])
                case['source']['input_format'] = 'records'
                del case['request']
    finally:
        connection.close()
    require(bool(selected), 'no eligible queue batches found')
    write(out, selected)
    return {'out': str(out), 'sampled': len(selected), 'gold_labels': 'unlabelled; annotate before semantic scoring'}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',required=True)
    parser.add_argument('--out',required=True)
    parser.add_argument('--limit',type=int,default=30)
    parser.add_argument('--seed',default='observer-eval-v1')
    parser.add_argument('--raw-records',action='store_true')
    args=parser.parse_args()
    print(json.dumps(sample_database(args.db,args.out,args.limit,args.seed,args.raw_records),ensure_ascii=False))

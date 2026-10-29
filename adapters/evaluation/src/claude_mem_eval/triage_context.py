"""Bounded, deterministic evidence selection and read-only memory snapshots."""
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import time

from llm_eval.evidence import digest

OBSERVATION_FIELDS = ('type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified')


def observation(value):
    return {k: value.get(k) for k in OBSERVATION_FIELDS}


def body_key(value):
    # A title alone is never a duplicate. Keep negation, numbers and fact order.
    facts = value.get('facts') or []
    narrative = value.get('narrative') or ''
    if not isinstance(facts, list) or any(not isinstance(f, str) for f in facts) or not isinstance(narrative, str):
        raise ValueError('invalid observation body')
    body = {'facts': [' '.join(f.split()) for f in facts], 'narrative': ' '.join(narrative.split()),
            'title': ' '.join((value.get('title') or '').split()),
            'subtitle': ' '.join((value.get('subtitle') or '').split())}
    return digest(body) if any(body['facts']) or body['narrative'] else None


def tokens(value):
    # Schema keys are not evidence: otherwise every record matches "facts/title".
    def content(v):
        if isinstance(v, dict):return ' '.join(content(x) for x in v.values())
        if isinstance(v, list):return ' '.join(content(x) for x in v)
        return v if isinstance(v, str) else ''
    text = content(value)
    lowered = text.casefold()
    latin = re.findall(r'[a-z0-9_./:-]{2,}', lowered)
    chinese = re.findall(r'[\u3400-\u9fff]+', lowered)
    return Counter(latin + [s[i:i+2] for s in chinese for i in range(max(0, len(s)-1))])


def overlap(query, text):
    words = tokens(text)
    return sum(min(n, words[word]) for word, n in query.items())


def evidence_windows(value, query, budget):
    """Select deterministic source lines; every excerpt is an exact original span."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    if len(text) <= budget:
        return [{'start': 0, 'end': len(text), 'text': text}], False
    # Bound long minified lines too; do not make a model decode an entire JSON string.
    spans, start = [], 0
    for line in text.splitlines(keepends=True):
        for offset in range(0, len(line), 360):
            lo = start + offset; hi = min(start+len(line), lo+360)
            spans.append((lo, hi))
        start += len(line)
    ranked = sorted(range(len(spans)), key=lambda i: (-overlap(query, text[spans[i][0]:spans[i][1]]), i))
    picked, remaining = [], budget
    for index in ranked:
        if remaining <= 0: break
        lo, hi = spans[index]; hi = min(hi, lo+remaining)
        picked.append({'start': lo, 'end': hi, 'text': text[lo:hi]}); remaining -= hi-lo
    merged = []
    for span in sorted(picked, key=lambda p: p['start']):
        if merged and merged[-1]['end'] == span['start']:
            merged[-1]['end'] = span['end']
            merged[-1]['text'] += span['text']
        else:
            merged.append(span)
    return merged, True


def source_evidence(records, obs, budget):
    query = tokens({'facts': obs.get('facts'), 'narrative': obs.get('narrative'), 'title': obs.get('title')})
    per = max(1, budget // len(records)); sources = []
    for i, record in enumerate(records):
        # An allowlist prevents source labels, outcomes and evaluator notes leaking.
        raw = {k: record.get(k) for k in ('tool_name', 'tool_input', 'tool_response')}
        tool_input, clipped_input = evidence_windows(raw['tool_input'], query, max(1, per//4))
        response, clipped_response = evidence_windows(raw['tool_response'], query, max(1, per-per//4))
        sources.append({'source_id': 'source-%d' % i, 'tool_name': str(raw['tool_name'])[:120],
                        'tool_input': tool_input, 'tool_response': response,
                        'omitted': clipped_input or clipped_response, 'source_sha256': digest(raw)})
    return sources


def freeze_memory(database, case, *, pool_limit=500, top_k=3):
    """Current rows created before the event; never claim an immutable historical view."""
    if type(pool_limit) is not int or not 1 <= pool_limit <= 1000 or type(top_k) is not int or not 0 <= top_k <= 5:
        raise ValueError('invalid memory retrieval bounds')
    project, cutoff = case.get('project'), case.get('cutoff_epoch')
    if not isinstance(project, str) or not project or type(cutoff) is not int or cutoff <= 0:
        raise ValueError('project and event cutoff required')
    obs = observation(case['observation']); key = body_key(obs)
    excluded = case.get('excluded_memory_ids', [])
    if not isinstance(excluded,list) or len(excluded)>4096 or any(type(i) is not int or i<=0 for i in excluded):
        raise ValueError('invalid excluded memory IDs')
    exclusion = (' AND id NOT IN ('+','.join('?' for _ in excluded)+')') if excluded else ''
    path = Path(database).expanduser().resolve()
    con = sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA query_only=ON'); con.execute('BEGIN')
    try:
        fields = 'id,project,title,subtitle,facts,narrative,created_at_epoch'
        params = (project, cutoff, *excluded)
        # Exact-body candidates first, including older rows outside the recency pool.
        exact = con.execute('SELECT '+fields+' FROM observations WHERE project=? AND created_at_epoch<? '+exclusion+' '
            'AND (title=? OR narrative=? OR facts=?) ORDER BY created_at_epoch DESC,id DESC LIMIT 32',
            (*params, obs.get('title'), obs.get('narrative'), json.dumps(obs.get('facts') or [], ensure_ascii=False, separators=(',', ':')))).fetchall()
        recent = con.execute('SELECT '+fields+' FROM observations WHERE project=? AND created_at_epoch<? '+exclusion+' '
            'ORDER BY created_at_epoch DESC,id DESC LIMIT ?', (*params, pool_limit)).fetchall()
        rows = {r['id']: dict(r) for r in [*exact, *recent]}
        for row in rows.values():
            row['facts'] = json.loads(row['facts']) if row['facts'] else []
        query = tokens(obs)
        ranked = sorted(rows.values(), key=lambda r: (not (key and key == body_key(r)), -overlap(query, observation(r)), -r['created_at_epoch'], r['id']))
        selected = [r for r in ranked if (key and key == body_key(r)) or overlap(query, observation(r)) > 0][:top_k]
    finally:
        con.close()
    captured = int(time.time()*1000)
    return {'schema_version': 1, 'project': project, 'cutoff_epoch': cutoff,
            'observation_sha256': digest(obs), 'captured_at_epoch': captured,
            'excluded_ids_sha256': digest(excluded),
            'read_mode': 'ro/query_only/read-transaction', 'pool_limit': pool_limit,
            'rows_considered': len(rows), 'complete': False, 'content_time_verified': False,
            'history_note': 'Rows were created before cutoff, but current contents may have changed; absence does not prove novelty.',
            'candidates': selected, 'candidates_sha256': digest(selected)}


def memory_evidence(case, budget):
    context = case.get('memory_context')
    if not isinstance(context, dict) or context.get('schema_version') != 1:
        raise ValueError('frozen memory snapshot required')
    obs = observation(case['observation']); candidates = context.get('candidates')
    if (not isinstance(candidates, list) or len(candidates)>5 or context.get('project') != case.get('project')
        or context.get('cutoff_epoch') != case.get('cutoff_epoch') or context.get('observation_sha256') != digest(obs)
        or context.get('candidates_sha256') != digest(candidates)
        or context.get('excluded_ids_sha256') != digest(case.get('excluded_memory_ids', []))):
        raise ValueError('memory snapshot binding mismatch')
    verified = context.get('content_time_verified') is True
    if verified and (context.get('read_mode') != 'immutable-precutoff-snapshot' or
                     type(context.get('captured_at_epoch')) is not int or context['captured_at_epoch'] > case['cutoff_epoch']):
        raise ValueError('historical memory content not verified')
    query = tokens(obs); rows = []; exact = []
    for r in candidates:
        if (not isinstance(r, dict) or type(r.get('id')) is not int or r['id'] <= 0 or r.get('project') != case['project']
            or type(r.get('created_at_epoch')) is not int or not 0 < r['created_at_epoch'] < case['cutoff_epoch']
            or (verified and r['created_at_epoch'] > context['captured_at_epoch'])
            or r['id'] in case.get('excluded_memory_ids', [])):
            raise ValueError('out-of-scope or future memory candidate')
        if body_key(obs) and body_key(obs) == body_key(r): exact.append(r['id'])
        spans, omitted = evidence_windows({k:r.get(k) for k in ('title','subtitle','facts','narrative')}, query, max(1, budget//max(1,len(candidates))))
        rows.append({'memory_id': r['id'], 'created_at_epoch': r['created_at_epoch'],
                     'body_evidence': spans, 'omitted': omitted})
    return {'candidates': rows, 'retrieval_complete': context.get('complete') is True,
            'historical_contents_verified': verified, 'absence_proves_new': False}, exact

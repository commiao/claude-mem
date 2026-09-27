#!/usr/bin/env python3
"""Read-only legacy RAM queue audit. Never restarts, imports, or calls a model.

Legacy logs are not a transaction journal. A depth sample identifies a FIFO
suffix, while a later receipt makes that suffix uncertain until the next depth
sample. Source matching is evidence of recoverability, NOT replay permission.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

HEADER = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\] \[([^\]]+)\] \[([^\]]+)\] (?:\[session-(\d+)\] )?", re.M)
ENQUEUE = re.compile(r"ENQUEUED \| sessionDbId=(\d+) \| messageId=(\d+) \| type=(observation|summarize)(?: \| tool=(.*))? \| depth=(\d+)\s*\Z", re.S)


def millis(value: str) -> int:
    return int(dt.datetime.strptime(value, '%Y-%m-%d %H:%M:%S.%f')
               .replace(tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)


def audit_logs(paths: list[Path], started: str) -> dict:
    sessions: dict[int, dict] = {}
    seen: set[int] = set()
    errors = []
    last_id = 0
    for path in sorted(paths):
        text = path.read_text(errors='replace')
        headers = list(HEADER.finditer(text))
        for index, header in enumerate(headers):
            timestamp, level, channel, sid = header.groups()
            if timestamp < started or not sid:
                continue
            end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
            body = text[header.end():end].rstrip()
            sid = int(sid)
            session = sessions.setdefault(sid, {'messages': [], 'uncertain_receipt': False,
                'depth_at': None, 'depth_evidence': None, 'gaps': []})
            match = ENQUEUE.fullmatch(body) if channel.strip() == 'QUEUE' else None
            if match:
                recorded_sid, message_id, kind, tool, depth = match.groups()
                message_id, depth = int(message_id), int(depth)
                if int(recorded_sid) != sid or message_id in seen or message_id <= last_id:
                    errors.append({'kind': 'identity_or_epoch_conflict', 'id': message_id,
                                   'path': str(path), 'timestamp': timestamp})
                    continue
                seen.add(message_id)
                last_id = message_id
                session['messages'].append({'id': message_id, 'kind': kind,
                    'formatted_tool': tool, 'enqueued_at': timestamp,
                    'log_path': str(path)})
                sample_depth(session, depth, timestamp, 'enqueue')
            elif channel.strip() == 'SESSION':
                if body.startswith(('Session removed from active sessions', 'Session deleted')):
                    sample_depth(session, 0, timestamp, 'session_removed')
                elif body.startswith('Generator paused for '):
                    pending = re.search(r'\bpendingCount=(\d+)\b', body)
                    if pending:
                        sample_depth(session, int(pending[1]), timestamp, 'generator_paused')
            elif (channel.strip() == 'DB' and body.startswith('STORED |')) or (
                    channel.strip() == 'PARSER' and 'ignoring queued batch' in body):
                session['uncertain_receipt'] = True
    return {'worker_started_at': started, 'sessions': sessions, 'errors': errors}


def sample_depth(session: dict, depth: int, timestamp: str, evidence: str) -> None:
    if depth > len(session['messages']):
        session['gaps'].append({'at': timestamp, 'depth': depth,
                                'known_messages': len(session['messages'])})
    session['messages'] = session['messages'][-depth:] if depth else []
    session['reported_depth'] = depth
    session['depth_at'] = timestamp
    session['depth_evidence'] = evidence
    session['uncertain_receipt'] = False


def format_tool(name: str, value) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return name
    if not isinstance(value, dict):
        return name
    keys = (['command'] if name == 'Bash' else []) + ['file_path', 'notebook_path']
    if name in ('Glob', 'Grep'):
        keys.append('pattern')
    keys += ['url', 'query']
    if name == 'Task':
        keys += ['subagent_type', 'description']
    for key in keys:
        if value.get(key):
            return f'{name}({value[key]})'
    return name


def source_events(paths: list[Path], wanted: set[str]):
    """Yield original source evidence; never claim it equals the lost hook body."""
    for path in paths:
        calls = {}
        with path.open('rb') as handle:
            while True:
                offset = handle.tell()
                line = handle.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                payload = record.get('payload', {})
                item = payload.get('item', {}) if isinstance(payload, dict) else {}
                if record.get('type') == 'event_msg' and payload.get('type') == 'item_completed':
                    kind = item.get('type')
                    if kind == 'CommandExecution':
                        command = item.get('command')
                        if not isinstance(command, list) or not command:
                            continue
                        label = format_tool('Bash', {'command': command[-1]})
                        if label not in wanted:
                            continue
                        # These are source fields, not an invented reconstruction
                        # of Codex's normalized PostToolUse hook JSON.
                        content = {'command': command, 'cwd': item.get('cwd'),
                            'stdout': item.get('stdout'), 'stderr': item.get('stderr'),
                            'aggregated_output': item.get('aggregated_output'),
                            'exit_code': item.get('exit_code')}
                    elif kind == 'McpToolCall':
                        name = f"mcp__{item.get('server')}__{item.get('tool')}"
                        label = format_tool(name, item.get('arguments'))
                        content = {'arguments': item.get('arguments'), 'result': item.get('result'),
                                   'status': item.get('status')}
                    elif kind == 'AgentMessage' and item.get('phase') == 'final':
                        label = '__summarize__'
                        content = {'last_assistant_message': item.get('content')}
                    elif kind == 'FileChange':
                        label = 'apply_patch'
                        content = {'changes': item.get('changes'), 'status': item.get('status'),
                            'stdout': item.get('stdout'), 'stderr': item.get('stderr')}
                    else:
                        continue
                    timestamp = payload.get('completed_at_ms')
                    if not isinstance(timestamp, int):
                        continue
                    yield evidence(path, offset, line, item.get('id'), label, timestamp, content)
                elif record.get('type') == 'response_item' and isinstance(payload, dict):
                    if payload.get('type') == 'function_call':
                        name = (payload.get('namespace') or '') + payload.get('name', '')
                        label = format_tool(name, payload.get('arguments'))
                        if label in wanted:
                            calls[payload.get('call_id')] = (label, payload, offset)
                    elif payload.get('type') == 'function_call_output' and payload.get('call_id') in calls:
                        label, call, call_offset = calls[payload['call_id']]
                        created = payload.get('internal_chat_message_metadata_passthrough', {}).get('create_time')
                        if not isinstance(created, (float, int)):
                            continue
                        result = evidence(path, offset, line, payload['call_id'], label, int(created * 1000),
                                          {'arguments': call.get('arguments'), 'output': payload.get('output')})
                        result['call_offset'] = call_offset
                        started = call.get('internal_chat_message_metadata_passthrough', {}).get('create_time')
                        if isinstance(started, (float, int)):
                            # Response serialization can follow PostToolUse;
                            # it is not the command-completion timestamp.
                            result['call_started_at_ms'] = int(started * 1000)
                            result['timestamp_kind'] = 'response_serialization'
                        yield result
                elif record.get('type') in ('assistant', 'user'):
                    message = record.get('message', {})
                    parts = message.get('content', []) if isinstance(message, dict) else []
                    if not isinstance(parts, list):
                        continue
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        if part.get('type') == 'tool_use':
                            label = format_tool(part.get('name', ''), part.get('input'))
                            if label in wanted:
                                calls[part.get('id')] = (label, part, offset)
                        elif part.get('type') == 'tool_result' and part.get('tool_use_id') in calls:
                            label, call, call_offset = calls[part['tool_use_id']]
                            try:
                                timestamp = int(dt.datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00')).timestamp() * 1000)
                            except (KeyError, ValueError):
                                continue
                            result = evidence(path, offset, line, part['tool_use_id'], label, timestamp,
                                {'tool_use': call, 'tool_result': part})
                            result['call_offset'] = call_offset
                            yield result


def evidence(path, offset, line, event_id, label, timestamp, content):
    return {'path': str(path), 'offset': offset, 'line_sha256': hashlib.sha256(line).hexdigest(),
        'event_id': event_id, 'label': label, 'completed_at_ms': timestamp,
        'content_sha256': hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()}


def match_sources(audit: dict, paths: list[Path], max_delay_ms: int = 10000) -> dict:
    wanted = {m['formatted_tool'] or '__summarize__' for s in audit['sessions'].values() for m in s['messages']}
    by_label = collections.defaultdict(list)
    for event in source_events(paths, wanted):
        by_label[event['label']].append(event)
    totals = collections.Counter()
    for session in audit['sessions'].values():
        for message in session['messages']:
            timestamp = millis(message['enqueued_at'])
            # A source completion must precede the hook enqueue. Future events
            # with the same command are never recovery evidence.
            matches = [e for e in by_label.get(message['formatted_tool'] or '__summarize__', [])
                       if temporal_match(e, timestamp, max_delay_ms)]
            content = {e['content_sha256'] for e in matches}
            message['source_status'] = 'unique_content' if len(content) == 1 else ('ambiguous' if content else 'missing')
            message['source_evidence'] = matches
            totals[message['source_status']] += 1
    audit['source_counts'] = dict(totals)
    audit['automatic_replay_allowed'] = False
    audit['limitations'] = [
        'Depth-derived suffixes are uncertain after an uncounted receipt.',
        'Original source evidence is not an exact normalized hook payload.',
        'No source match proves that a paid model request never started.',
        'Unsupported source event types remain missing; absence is not proof of deletion.',
        'This read-only audit never grants permission to restart or replay.',
    ]
    return audit


def temporal_match(event: dict, timestamp: int, max_delay_ms: int) -> bool:
    if event.get('timestamp_kind') == 'response_serialization':
        return (event['call_started_at_ms'] <= timestamp
                and -max_delay_ms <= timestamp - event['completed_at_ms'] <= max_delay_ms)
    return 0 <= timestamp - event['completed_at_ms'] <= max_delay_ms


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--logs', type=Path, required=True)
    parser.add_argument('--worker-started-at', required=True)
    parser.add_argument('--source-root', action='append', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    audit = audit_logs(list(args.logs.glob('claude-mem-*.log')), args.worker_started_at)
    files = sorted({p for root in args.source_root for p in root.rglob('*.jsonl')})
    match_sources(audit, files)
    # Exclusive creation prevents an accidental overwrite of prior evidence.
    import os
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(audit, handle, ensure_ascii=False, indent=2)
    pending = [s for s in audit['sessions'].values() if s['messages']]
    print(json.dumps({'sessions': len(pending), 'known_suffix_messages': sum(len(s['messages']) for s in pending),
        'uncertain_sessions': sum(s['uncertain_receipt'] for s in pending), 'errors': len(audit['errors']),
        'sources': audit['source_counts'], 'automatic_replay_allowed': False}))


if __name__ == '__main__':
    main()

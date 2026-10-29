"""Explicit, no-retry SystemOne transport for shared manual packets.

Uses the shared engine for run validation and import. Evidence remains
manual-declared: this is not a native executor or independent admission.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from llm_eval import engine
from llm_eval.evidence import read, verify
from .triage import ObservationTriage, within_route_budget

BUSINESS = 'kg_hub.obs_triage'


def stamp():
    return datetime.now(timezone.utc).isoformat()


def append(path, row):
    with path.open('a') as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + '\n')
        handle.flush()
        os.fsync(handle.fileno())


def save(path, data):
    with path.open('xb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def caller_token(host, config):
    # Existing route-specific caller only. Never fall back to another caller,
    # expose a token on argv, or persist the SSH stdout containing the token.
    match=re.fullmatch(r'[A-Za-z_][\w.-]*@(100\.\d+\.\d+\.\d+)',host)
    if not match or ipaddress.ip_address(match[1]) not in ipaddress.ip_network('100.64.0.0/10') or not config.startswith('/') or '\n' in config:
        raise ValueError('unverified_caller_source')
    code = 'import json; a=json.load(open(' + repr(config) + ')); c=a["callers"]["kg_hub.obs_triage"]; assert c["business_keys"]==["kg_hub.obs_triage"]; print(c["token"],end="")'
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ProxyJump=none', host,
               "python3 - <<'PY'\n" + code + '\nPY']
    result = subprocess.run(command, capture_output=True, timeout=25)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError('dedicated_caller_unavailable')
    return result.stdout.decode().strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def execute(run, authorization, url, token_loader, *, opener=None, scenario='claude_mem.observation_triage'):
    if scenario == 'claude_mem.observation_triage_v2':
        from .triage_v2 import ObservationTriageV2
        adapter = ObservationTriageV2()
    elif scenario == 'claude_mem.observation_triage':
        adapter = ObservationTriage()
    else:
        raise ValueError('unsupported_triage_scenario')
    plan = engine.load_run(adapter, run)
    permit = verify(read(authorization))
    if (permit.get('business_key') != BUSINESS or permit.get('plan_sha256') != plan['sha256'] or
        permit.get('max_calls') != 33 or permit.get('generation_calls') != 0 or
        permit.get('probes') != 0 or permit.get('automatic_retries') != 0 or not permit.get('user_authorization')):
        raise ValueError('explicit_fixed_cohort_authorization_required')
    if scenario.endswith('_v2') and permit.get('scenario') != scenario:
        raise ValueError('explicit_v2_authorization_required')
    endpoint = urllib.parse.urlsplit(url)
    if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or endpoint.port != 39002 or endpoint.path not in ('', '/') or endpoint.query or endpoint.fragment or endpoint.username:
        raise ValueError('verified_loopback_gateway_required')
    jobs = plan['jobs']
    if len(jobs) != 33 or plan['repeat'] != 1 or plan['recovery_calls'] != 0 or any(c['executor'] != 'manual' for c in plan['candidates']):
        raise ValueError('fixed_33_manual_packets_required')
    for job in jobs:
        if scenario.endswith('_v2') and job['request'].get('execution') == 'local':
            if job['request'].get('local_action') not in ('drop','review') or job['request'].get('body') is not None:
                raise ValueError('invalid_local_decision_packet')
            continue
        body = job['request'].get('body', {})
        if body.get('business_key') != BUSINESS or len(body.get('messages', [])) != 1:
            raise ValueError('invalid_business_packet')
        query = body['messages'][0]
        if query.get('role') != 'user' or not isinstance(query.get('content'), str) or not within_route_budget(body):
            raise ValueError('invalid_decision_wire_budget')
    root = Path(run) / 'business-transport'
    root.mkdir(mode=0o700, exist_ok=True)
    ledger = root / 'calls.jsonl'
    opener = opener or urllib.request.build_opener(NoRedirect())
    with (root / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        existing = [json.loads(line) for line in ledger.read_text().splitlines()] if ledger.exists() else []
        # A stopped/unknown transport never resumes implicitly. This includes
        # successful calls whose shared import was interrupted after response.
        if existing:
            raise ValueError('transport_already_attempted_no_automatic_replay')
        token = None
        succeeded, local_count, stop = 0, 0, None
        next_start=0.0
        for number, job in enumerate(jobs, 1):
            if number > permit['max_calls']:
                raise ValueError('judge_budget_exhausted')
            if scenario.endswith('_v2') and job['request'].get('execution') == 'local':
                text = json.dumps({'deterministic_action':job['request']['local_action'],'reason':job['request']['local_reason']})
                engine.import_results(adapter, run, [{'id':job['id'],'plan_sha256':plan['sha256'],
                    'request_sha256':job['request_sha256'],'text':text,'ms':0,'stop':'local_deterministic'}])
                append(ledger, {'job':job['id'],'number':number,'state':'local_imported','at':stamp(),
                                'plan_sha256':plan['sha256'],'request_sha256':job['request_sha256'],'external_calls':0})
                local_count += 1
                continue
            if token is None:
                token = token_loader()
            time.sleep(max(0.0,next_start-time.monotonic()))
            next_start=time.monotonic()+2.1  # serial; below the verified 30 RPM route cap
            body = json.dumps(job['request']['body'], ensure_ascii=False, separators=(',', ':')).encode()
            key = 'memcheck-triage-' + hashlib.sha256((plan['sha256'] + job['request_sha256'] + job['id']).encode()).hexdigest()
            directory = root / ('call-%02d' % number)
            directory.mkdir(mode=0o700)
            save(directory / 'request.json', body)
            record = {'job': job['id'], 'number': number, 'state': 'started', 'at': stamp(),
                      'plan_sha256': plan['sha256'], 'request_sha256': job['request_sha256'], 'idempotency_key': key}
            append(ledger, record)  # Durable BEFORE the only permitted POST.
            request = urllib.request.Request(url.rstrip('/') + '/v1/invoke', data=body, method='POST',
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Idempotency-Key': key})
            started = datetime.now(timezone.utc)
            try:
                with opener.open(request, timeout=45) as response:
                    status, raw = response.status, response.read()
            except urllib.error.HTTPError as error:
                status, raw = error.code, error.read()
            except Exception as error:
                stop = 'unknown_transport_outcome'
                append(ledger, {**record, 'state': 'unknown', 'at': stamp(), 'error_type': type(error).__name__})
                break
            save(directory / 'response.json', raw)
            elapsed = (datetime.now(timezone.utc)-started).total_seconds()*1000
            if status != 200:
                stop = 'http_%s' % status
                append(ledger, {**record, 'state': 'http_failure', 'at': stamp(), 'http_status': status, 'ms': elapsed,
                                'provider_execution_unknown': status>=500 or status==408})
                break  # 429/auth/refusal does not spend the remaining budget.
            try:
                document = json.loads(raw)
                content = document['output']['content']
                if not isinstance(content, str):
                    raise ValueError('nontext_systemone_envelope')
            except (KeyError, TypeError, ValueError):
                stop = 'unknown_gateway_envelope'
                append(ledger, {**record, 'state': 'unknown', 'at': stamp(), 'http_status': status})
                break
            # Preserve exact business reply and the gateway's usage claim. The
            # shared importer deliberately keeps manual identity/cost grades.
            engine.import_results(adapter, run, [{'id': job['id'], 'plan_sha256': plan['sha256'],
                'request_sha256': job['request_sha256'], 'text': content, 'usage': document.get('usage'),
                'ms': elapsed, 'stop': 'stop'}])
            succeeded += 1
            append(ledger, {**record, 'state': 'imported', 'at': stamp(), 'http_status': status, 'ms': elapsed,
                            'response_sha256': hashlib.sha256(raw).hexdigest(), 'usage': document.get('usage')})
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        summary = {'planned_judge_calls': 33, 'started': sum(r['state']=='started' for r in rows),
                   'imported': succeeded+local_count, 'imported_judge': succeeded, 'local_decisions':local_count,
                   'not_attempted': 33-local_count-sum(r['state']=='started' for r in rows),
                   'stopped_reason': stop, 'generation_calls': 0, 'probes': 0, 'automatic_retries': 0,
                   'evidence_grade': 'manual-declared shared import plus local HTTP journal; no independent admission',
                   'money_cost': None, 'credits_measured': False}
        save(root / 'summary.json', json.dumps(summary, indent=2).encode())
        return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--scenario', choices=['claude_mem.observation_triage','claude_mem.observation_triage_v2'],
                        default='claude_mem.observation_triage')
    parser.add_argument('--authorization', type=Path, required=True)
    parser.add_argument('--execute', action='store_true', required=True)
    parser.add_argument('--gateway-url', default='http://127.0.0.1:39002')
    parser.add_argument('--caller-host', required=True)
    parser.add_argument('--caller-config', required=True)
    args=parser.parse_args()
    result=execute(args.run.resolve(),args.authorization.resolve(),args.gateway_url,
                   lambda:caller_token(args.caller_host,args.caller_config),scenario=args.scenario)
    print(json.dumps(result))


if __name__=='__main__':
    main()

#!/usr/bin/env python3
"""Explicit local cutover stages; never stop or signal the legacy worker.

Run capture only AFTER all hook clients contain the handoff journal code and
the legacy restart guard is installed. Preparation waits for existing hook
processes to finish. Start the isolated service separately, then run switch.
The journal stays closed to processing until explicitly drained.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.request
from pathlib import Path
from capture_handoff_journal import initialize
from prepare_isolated_capture import prepare

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def atomic_json(path, value):
    path=Path(path);temp=path.with_name(path.name+'.cutover-tmp')
    fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    try:
        with os.fdopen(fd,'w') as out:
            json.dump(value,out,ensure_ascii=False,indent=2);out.flush();os.fsync(out.fileno())
        os.replace(temp,path)
    finally:
        if temp.exists():temp.unlink()
def health(port):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=5) as r:return json.load(r)
def hooks():
    rows={}
    result=subprocess.run(['ps','-axo','pid=,lstart=,command='],capture_output=True,text=True,check=True)
    for line in result.stdout.splitlines():
        fields=line.strip().split(None,6)
        if len(fields)==7 and 'worker-service.cjs hook ' in fields[6]:rows[int(fields[0])]=' '.join(fields[1:])
    return rows

def main(a):
    if not re.fullmatch('[a-zA-Z0-9_-]{1,64}',a.generation):raise ValueError('invalid generation')
    old=a.legacy_dir;new=a.new_dir;control=old/'capture-handoff.json';journal=old/('capture-handoff-'+a.generation+'.sqlite3')
    receipt=old/('capture-handoff-'+a.generation+'.receipt.json')
    if health(a.legacy_port).get('pid')!=a.legacy_pid:raise ValueError('legacy worker identity changed')
    if a.new_port==a.legacy_port or old.resolve()==new.resolve():raise ValueError('runtime isolation required')
    if a.stage=='capture':
        if control.exists() or receipt.exists():raise ValueError('handoff already exists; inspect and resume explicitly')
        if not a.bundle or not a.bundle_sha:raise ValueError('capture requires expected bundle paths and sha')
        for bundle in a.bundle:
            if digest(bundle)!=a.bundle_sha:raise ValueError('installed hook bundle differs from tested release')
        marker=json.loads(a.preserve_marker.read_text())
        if marker.get('pid')!=a.legacy_pid:raise ValueError('legacy preservation marker mismatch')
        initialize(journal,a.generation)
        atomic_json(control,{'generation':a.generation,'journal':str(journal)})
        existing=hooks()
        atomic_json(receipt,{'generation':a.generation,'phase':'capturing','prior_hooks':existing,'legacy_pid':a.legacy_pid,'bundle_sha256':a.bundle_sha})
        print(json.dumps({'phase':'capturing','prior_hooks':len(existing)}));return
    state=json.loads(receipt.read_text())
    if state['generation']!=a.generation:raise ValueError('receipt generation mismatch')
    if a.stage=='prepare':
        if state['phase']!='capturing':raise ValueError('wrong preparation phase')
        deadline=time.monotonic()+120
        prior={int(k):v for k,v in state['prior_hooks'].items()}
        while True:
            live=hooks()
            remaining=[pid for pid,token in prior.items() if live.get(pid)==token]
            if not remaining:break
            if time.monotonic()>deadline:raise ValueError('prior hook processes still active; journal retained')
            time.sleep(1)
        if (old/'transcript-watch.json').exists():raise ValueError('legacy transcript capture requires separate quiescence proof')
        if new.exists():raise ValueError('new runtime directory already exists')
        raw=(old/'settings.json').read_bytes();settings=json.loads(raw);settings=settings.get('env',settings)
        if settings.get('CLAUDE_MEM_RUNTIME','worker')!='worker':raise ValueError('only local worker runtime supported')
        new.mkdir(mode=0o700)
        result=prepare(old/'claude-mem.db',new/'claude-mem.db',a.generation)
        for marker in ['.cwd-remap-applied-v1','.cleanup-v12.4.3-applied']:
            data=(old/marker).read_bytes();(new/marker).write_bytes(data)
        (new/'legacy-settings.before.json').write_bytes(raw);(new/'legacy-settings.before.json').chmod(0o600)
        updated={**settings,'CLAUDE_MEM_DATA_DIR':str(new),'CLAUDE_MEM_WORKER_PORT':str(a.new_port),'CLAUDE_MEM_WORKER_HOST':'127.0.0.1','CLAUDE_MEM_CHROMA_ENABLED':'false','CLAUDE_MEM_TRANSCRIPTS_ENABLED':'false','CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION':'false','CLAUDE_MEM_CLOUD_SYNC_HUB_URL':'','CLAUDE_MEM_CLOUD_SYNC_TOKEN':'','CLAUDE_MEM_CLOUD_SYNC_USER_ID':''}
        atomic_json(new/'settings.json',updated)
        if digest(old/'settings.json')!=hashlib.sha256(raw).hexdigest():raise ValueError('legacy settings changed during preparation')
        state.update(phase='prepared',settings_sha256=hashlib.sha256(raw).hexdigest(),preparation=result)
        atomic_json(receipt,state);print(json.dumps({'phase':'prepared',**result}));return
    if a.stage=='rollback-routing':
        if state['phase']!='routed':raise ValueError('wrong rollback phase')
        with sqlite3.connect(journal) as db:
            if db.execute("SELECT 1 FROM handoff_events WHERE state!='queued' LIMIT 1").fetchone():
                raise ValueError('delivery already attempted; rollback must retain and reconcile new work')
        with sqlite3.connect(new/'claude-mem.db') as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='observer_tasks'").fetchone():
                if db.execute('SELECT 1 FROM observer_tasks LIMIT 1').fetchone():raise ValueError('new durable work exists')
        if health(a.new_port).get('activeSessions')!=0:raise ValueError('new active work exists')
        if digest(old/'settings.json')!=state['routed_settings_sha256']:raise ValueError('routed settings changed')
        backup=new/'legacy-settings.before.json'
        if digest(backup)!=state['settings_sha256']:raise ValueError('rollback snapshot differs')
        atomic_json(old/'settings.json',json.loads(backup.read_text()))
        state['phase']='prepared';atomic_json(receipt,state)
        print(json.dumps({'phase':'prepared','journal':'retained; no worker stopped'}));return
    if state['phase']!='prepared':raise ValueError('wrong switch phase')
    with sqlite3.connect(new/'claude-mem.db') as db:
        generation=db.execute('SELECT generation FROM capture_generation').fetchone()
        if generation!=(a.generation,):raise ValueError('new database generation mismatch')
    ready=health(a.new_port)
    if ready.get('status')!='ok' or ready.get('pid') in (None,a.legacy_pid):raise ValueError('isolated worker not healthy')
    owner=json.loads((new/'worker.pid').read_text())
    if owner.get('pid')!=ready.get('pid') or owner.get('port')!=a.new_port:raise ValueError('new PID ownership mismatch')
    command=subprocess.run(['ps','-p',str(ready['pid']),'-o','command='],capture_output=True,text=True,check=True).stdout
    bundles=[part for part in command.split() if part.endswith('/worker-service.cjs')]
    if len(bundles)!=1 or digest(bundles[0])!=state['bundle_sha256']:raise ValueError('running bundle mismatch')
    if ready.get('activeSessions')!=0:raise ValueError('new runtime already has active work')
    with urllib.request.urlopen('http://127.0.0.1:'+str(a.new_port)+'/api/readiness',timeout=5) as r:
        if r.status!=200:raise ValueError('isolated worker not ready')
    if digest(old/'settings.json')!=state['settings_sha256']:raise ValueError('legacy settings changed; routing not overwritten')
    raw=json.loads((old/'settings.json').read_text());nested=raw.get('env',raw)
    nested.update(CLAUDE_MEM_DATA_DIR=str(new),CLAUDE_MEM_WORKER_PORT=str(a.new_port))
    atomic_json(old/'settings.json',raw)
    state.update(phase='routed',new_pid=ready['pid'],routed_settings_sha256=digest(old/'settings.json'));atomic_json(receipt,state)
    print(json.dumps({'phase':'routed','new_pid':ready['pid'],'journal':'still capturing; explicit drain required'}))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('stage',choices=['capture','prepare','switch','rollback-routing'])
    p.add_argument('--legacy-dir',type=Path,required=True);p.add_argument('--new-dir',type=Path,required=True)
    p.add_argument('--legacy-port',type=int,required=True);p.add_argument('--new-port',type=int,required=True)
    p.add_argument('--legacy-pid',type=int,required=True);p.add_argument('--generation',required=True)
    p.add_argument('--preserve-marker',type=Path);p.add_argument('--bundle',type=Path,action='append');p.add_argument('--bundle-sha')
    main(p.parse_args())

#!/usr/bin/env python3
"""Operate a temporary capture admission journal. Never retry uncertain dispatch.

Only events intercepted BEFORE their normal handler executes are eligible.
This is not a recovery/replay mechanism for the legacy observer RAM queue.
"""
from __future__ import annotations
import argparse
import json
import os
import sqlite3
import subprocess
from pathlib import Path

def initialize(path, generation):
    fd=os.open(path, os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
    db=sqlite3.connect(path)
    try:
        db.executescript('''PRAGMA synchronous=FULL;
CREATE TABLE handoff_control(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,phase TEXT NOT NULL);
CREATE TABLE handoff_events(id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,event TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','dispatching','delivered','uncertain')));
''')
        db.execute('INSERT INTO handoff_control VALUES(1,?,\'capture\')',(generation,));db.commit()
    finally:db.close()

def drain(path, generation, deliver):
    db=sqlite3.connect(path, timeout=10)
    db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA synchronous=FULL')
        while True:
            db.execute('BEGIN IMMEDIATE')
            control=db.execute('SELECT generation,phase FROM handoff_control WHERE id=1').fetchone()
            if control is None or control['generation']!=generation:
                raise ValueError('journal generation mismatch')
            if db.execute("SELECT 1 FROM handoff_events WHERE state IN ('dispatching','uncertain') LIMIT 1").fetchone():
                raise ValueError('uncertain prior delivery: manual reconciliation required')
            row=db.execute("SELECT * FROM handoff_events WHERE state='queued' ORDER BY id LIMIT 1").fetchone()
            if row is None:
                # Atomic with hook-side admissions: subsequent hooks run live;
                # hooks that saw the old control file still read this DB phase.
                db.execute("UPDATE handoff_control SET phase='closed' WHERE id=1")
                db.commit();return
            if control['phase']!='capture':raise ValueError('closed journal contains queued work')
            db.execute("UPDATE handoff_events SET state='dispatching' WHERE id=?",(row['id'],));db.commit()
            success=False
            try:success=deliver(dict(row))
            finally:
                db.execute('UPDATE handoff_events SET state=? WHERE id=?',('delivered' if success else 'uncertain',row['id']));db.commit()
            if not success:raise ValueError('delivery uncertain; retained without automatic retry')
    finally:db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['initialize','drain'])
    p.add_argument('--journal',type=Path,required=True);p.add_argument('--generation',required=True)
    p.add_argument('--bundle',type=Path);p.add_argument('--bun',type=Path);p.add_argument('--data-dir',type=Path);p.add_argument('--port',type=int)
    p.add_argument('--control',type=Path)
    a=p.parse_args()
    if a.operation=='initialize':initialize(a.journal,a.generation)
    else:
        if not all([a.bundle,a.bun,a.data_dir,a.port,a.control]):p.error('drain requires bundle, bun, data-dir, port and control')
        configuration=json.loads((a.data_dir/'settings.json').read_text())
        if configuration.get('CLAUDE_MEM_RUNTIME','worker') not in ('worker','local'):p.error('only local worker delivery supported')
        env={**os.environ,'CLAUDE_MEM_DATA_DIR':str(a.data_dir),'CLAUDE_MEM_WORKER_PORT':str(a.port),'CLAUDE_MEM_HANDOFF_REPLAY':a.generation,'CLAUDE_MEM_HANDOFF_CONTROL':str(a.control),'DO_NOT_TRACK':'1'}
        def deliver(row):
            # No payload or child output is printed; original bytes stay local.
            result=subprocess.run([str(a.bun),str(a.bundle),'hook',row['platform'],row['event']],input=row['payload'],text=True,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90)
            return result.returncode==0
        drain(a.journal,a.generation,deliver)

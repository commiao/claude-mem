#!/usr/bin/env python3
"""Repair only single inherited prompt counters under a capturing admission gate."""
from __future__ import annotations
import argparse
import sqlite3
from pathlib import Path

def repair(database, journal, generation):
    gate=sqlite3.connect(Path(journal).resolve().as_uri()+'?mode=ro',uri=True)
    try:
        if gate.execute('SELECT generation,phase FROM handoff_control WHERE id=1').fetchone()!=(generation,'capture'):
            raise ValueError('capturing generation required')
        if gate.execute("SELECT 1 FROM handoff_events WHERE state IN ('dispatching','uncertain') OR (state='delivered' AND event IN ('session-init','user-message')) LIMIT 1").fetchone():
            raise ValueError('prompt delivery requires separate reconciliation')
        db=sqlite3.connect(database,timeout=10)
        try:
            db.execute('PRAGMA synchronous=FULL');db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT generation FROM capture_generation').fetchall()!=[(generation,)]:
                raise ValueError('database generation mismatch')
            rows=db.execute("SELECT p.session_db_id,count(*),min(p.prompt_number),max(p.prompt_number) FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id WHERE s.content_session_id NOT LIKE 'legacy/%' GROUP BY p.session_db_id").fetchall()
            if any(count!=1 or low<1 for _,count,low,high in rows):
                raise ValueError('only single inherited prompts may be repaired')
            changed=0
            for sid,count,low,high in rows:
                if high!=1:
                    db.execute('UPDATE user_prompts SET prompt_number=1 WHERE session_db_id=?',(sid,));changed+=1
            db.commit();return changed
        finally:db.close()
    finally:gate.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database',type=Path,required=True);p.add_argument('--journal',type=Path,required=True);p.add_argument('--generation',required=True)
    a=p.parse_args();print({'repaired_sessions':repair(a.database,a.journal,a.generation)})

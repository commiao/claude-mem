#!/usr/bin/env python3
"""Prepare a new capture DB from a live read-only backup; never stop its owner.

Historical memory sessions stay queryable. New capture session rows inherit
only the latest user prompt (including privacy) and have no SDK memory id.
Copied observations are a baseline, never new work to replay or synchronize.
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import re
import sqlite3
from pathlib import Path

def prepare(source, destination, generation):
    source, destination = Path(source), Path(destination)
    if not re.fullmatch('[a-zA-Z0-9_-]{1,64}', generation):
        raise ValueError('invalid generation')
    if source.resolve() == destination.resolve():
        raise ValueError('source and destination must differ')
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    old = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)
    db = sqlite3.connect(str(destination))
    db.row_factory = sqlite3.Row
    try:
        old.backup(db)
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('source integrity failed')
        # This path is specifically for the legacy RAM-only worker. Do not
        # copy durable in-flight task identities into a second consumer.
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='observer_tasks'").fetchone():
            if db.execute('SELECT count(*) FROM observer_tasks').fetchone()[0]:
                raise ValueError('durable observer tasks require a different handoff')
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='capture_generation'").fetchone():
            raise ValueError('source is already an isolated generation')
        prior_fk = {tuple(r) for r in db.execute('PRAGMA foreign_key_check')}
        db.execute('BEGIN IMMEDIATE')
        baseline = db.execute('SELECT coalesce(max(id),0) FROM observations').fetchone()[0]
        sessions = db.execute('SELECT * FROM sdk_sessions ORDER BY id').fetchall()
        for session in sessions:
            row = dict(session)
            prior_id = row.pop('id')
            original = row['content_session_id']
            latest = db.execute('SELECT * FROM user_prompts WHERE session_db_id=? ORDER BY prompt_number DESC,id DESC LIMIT 1', (prior_id,)).fetchone()
            archived = 'legacy/' + generation + '/' + str(prior_id)
            db.execute('UPDATE sdk_sessions SET content_session_id=? WHERE id=?', (archived, prior_id))
            db.execute('UPDATE user_prompts SET content_session_id=? WHERE session_db_id=?', (archived, prior_id))
            row.update(memory_session_id=None, worker_port=None, completed_at=None,
                       completed_at_epoch=None, status='active')
            names = list(row)
            new_id = db.execute('INSERT INTO sdk_sessions (' + ','.join(names) + ') VALUES (' + ','.join('?' for _ in names) + ')', list(row.values())).lastrowid
            if latest:
                prompt = dict(latest)
                prompt.pop('id')
                prompt.update(session_db_id=new_id, content_session_id=original, prompt_number=1)
                names = list(prompt)
                db.execute('INSERT INTO user_prompts (' + ','.join(names) + ') VALUES (' + ','.join('?' for _ in names) + ')', list(prompt.values()))
        db.execute('CREATE TABLE capture_generation (generation TEXT PRIMARY KEY, baseline_observation_id INTEGER NOT NULL, source_path TEXT NOT NULL, prepared_at TEXT NOT NULL)')
        db.execute('INSERT INTO capture_generation VALUES (?,?,?,?)', (generation, baseline, str(source.resolve()), datetime.datetime.now(datetime.timezone.utc).isoformat()))
        if {tuple(r) for r in db.execute('PRAGMA foreign_key_check')} != prior_fk:
            raise ValueError('handoff changed pre-existing foreign key violations')
        db.commit()
        return {'generation': generation, 'baseline_observation_id': baseline, 'inherited_sessions': len(sessions), 'preserved_foreign_key_violations': len(prior_fk)}
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()
        old.close()

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--generation',required=True)
    args=parser.parse_args()
    print(json.dumps(prepare(args.source,args.destination,args.generation)))

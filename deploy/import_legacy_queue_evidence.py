#!/usr/bin/env python3
"""Stage legacy RAM queue evidence beside durable observer tasks, without replay.

This imports identities and source classifications only. It cannot establish an
exact hook payload or whether a paid call started, so it never writes to
observer_tasks and never authorizes a model request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS legacy_queue_evidence (
    worker_started_at TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    legacy_session_db_id INTEGER NOT NULL,
    content_session_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('observation', 'summarize')),
    source_status TEXT NOT NULL CHECK(source_status IN ('unique_content', 'ambiguous', 'missing')),
    source_matches INTEGER NOT NULL,
    audit_sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'needs_manual_reconciliation'
        CHECK(disposition = 'needs_manual_reconciliation'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (worker_started_at, message_id)
);
"""


def stage(audit_path: Path, target_db: Path, evidence_dir: Path, expected_depth: int) -> dict:
    raw = audit_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    audit = json.loads(raw)
    if audit.get('automatic_replay_allowed') is not False or audit.get('errors'):
        raise ValueError('audit is not safe evidence')
    epoch = audit['worker_started_at']
    rows = []
    for sid, session in audit['sessions'].items():
        if not session['messages']:
            continue
        if session.get('gaps') or session.get('uncertain_receipt'):
            raise ValueError('uncertain queue boundary')
        for message in session['messages']:
            rows.append((epoch, message['id'], int(sid), session.get('content_session_id'),
                         message['kind'], message['source_status'],
                         len(message.get('source_evidence', [])), digest))
    if len(rows) != expected_depth or len({r[1] for r in rows}) != len(rows):
        raise ValueError('queue depth or message identity mismatch')
    if dict(__import__('collections').Counter(r[5] for r in rows)) != audit['source_counts']:
        raise ValueError('audit source counts mismatch')
    if not target_db.is_file():
        raise ValueError('durable target database missing')
    evidence_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(evidence_dir, 0o700)
    archived = evidence_dir / (digest + '.json')
    if archived.exists():
        if hashlib.sha256(archived.read_bytes()).hexdigest() != digest:
            raise ValueError('archived audit hash mismatch')
    else:
        fd = os.open(archived, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            archived.unlink(missing_ok=True)
            raise
    backup = evidence_dir / (digest + '.target-before.sqlite3')
    if not backup.exists():
        with sqlite3.connect(target_db) as source, sqlite3.connect(backup) as destination:
            source.backup(destination)
        os.chmod(backup, 0o600)
    with sqlite3.connect(target_db, timeout=30) as db:
        db.executescript(SCHEMA)
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT COUNT(*) FROM legacy_queue_evidence WHERE worker_started_at=?',
                              (epoch,)).fetchone()[0]
        if existing:
            saved = db.execute('SELECT DISTINCT audit_sha256 FROM legacy_queue_evidence WHERE worker_started_at=?',
                               (epoch,)).fetchall()
            if existing != len(rows) or saved != [(digest,)]:
                raise ValueError('legacy epoch already imported from different evidence')
        else:
            db.executemany('''INSERT INTO legacy_queue_evidence
                (worker_started_at, message_id, legacy_session_db_id, content_session_id,
                 kind, source_status, source_matches, audit_sha256)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)''', rows)
        db.commit()
    return {'staged': len(rows), 'source_counts': audit['source_counts'],
            'disposition': 'needs_manual_reconciliation', 'audit_sha256': digest,
            'archived_audit': str(archived), 'database_backup': str(backup)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--target-db', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--expected-depth', type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.audit, args.target_db, args.evidence_dir, args.expected_depth)))


if __name__ == '__main__':
    main()

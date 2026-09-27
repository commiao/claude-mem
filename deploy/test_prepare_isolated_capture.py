import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('prepare',Path(__file__).with_name('prepare_isolated_capture.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

class PrepareCaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.source=Path(self.tmp.name)/'old.db';self.dest=Path(self.tmp.name)/'new.db'
        c=sqlite3.connect(self.source)
        c.executescript('''CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,content_session_id TEXT, memory_session_id TEXT UNIQUE, worker_port INTEGER, completed_at TEXT,completed_at_epoch INTEGER,status TEXT);
CREATE TABLE observations(id INTEGER PRIMARY KEY,memory_session_id TEXT REFERENCES sdk_sessions(memory_session_id));
CREATE TABLE user_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT,session_db_id INTEGER REFERENCES sdk_sessions(id),content_session_id TEXT,prompt_number INTEGER,prompt_text TEXT);
INSERT INTO sdk_sessions VALUES(1,'source','sdk-old',37701,NULL,NULL,'active');
INSERT INTO observations VALUES(1,'sdk-old');
INSERT INTO user_prompts VALUES(1,1,'source',1,'earlier');
INSERT INTO user_prompts VALUES(2,1,'source',2,'<private>never ingest this</private>');''');c.close()
    def query(self,path,sql):
        c=sqlite3.connect(path)
        try:return c.execute(sql).fetchall()
        finally:c.close()
    def test_history_and_privacy_preserved_without_reusing_sdk_conversation(self):
        result=p.prepare(self.source,self.dest,'cutover')
        self.assertEqual(result['baseline_observation_id'],1)
        self.assertEqual(self.query(self.source,'SELECT content_session_id,memory_session_id FROM sdk_sessions'),[('source','sdk-old')])
        self.assertEqual(self.query(self.dest,"SELECT memory_session_id,worker_port FROM sdk_sessions WHERE content_session_id='source'"),[(None,None)])
        self.assertEqual(self.query(self.dest,"SELECT prompt_number,prompt_text FROM user_prompts WHERE content_session_id='source'"),[(2,'<private>never ingest this</private>')])
        self.assertEqual(self.query(self.dest,'SELECT memory_session_id FROM observations'),[('sdk-old',)])
    def test_existing_orphans_survive_unchanged(self):
        c=sqlite3.connect(self.source);c.execute("INSERT INTO observations VALUES(2,'orphan')");c.commit();c.close()
        result=p.prepare(self.source,self.dest,'cutover')
        self.assertEqual(result['preserved_foreign_key_violations'],1)
    def test_refuses_overwrite_and_durable_inflight_queue(self):
        self.dest.write_text('reserved')
        with self.assertRaises(FileExistsError):p.prepare(self.source,self.dest,'cutover')
        self.assertEqual(self.dest.read_text(),'reserved')
        other=Path(self.tmp.name)/'other.db'
        c=sqlite3.connect(self.source);c.executescript('CREATE TABLE observer_tasks(id TEXT); INSERT INTO observer_tasks VALUES("paid-task");');c.close()
        with self.assertRaisesRegex(ValueError,'different handoff'):p.prepare(self.source,other,'cutover')
        self.assertEqual(self.query(other,"SELECT count(*) FROM sqlite_master WHERE name='capture_generation'"),[(0,)])

if __name__=='__main__':unittest.main()

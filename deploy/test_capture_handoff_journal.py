import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('j',Path(__file__).with_name('capture_handoff_journal.py'))
j=importlib.util.module_from_spec(spec);spec.loader.exec_module(j)
class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'journal.db';j.initialize(self.path,'g')
    def add(self,state='queued'):
        c=sqlite3.connect(self.path);c.execute('INSERT INTO handoff_events(platform,event,payload,state) VALUES(?,?,?,?)',('codex','observation','{}',state));c.commit();c.close()
    def rows(self,sql):
        c=sqlite3.connect(self.path)
        try:return c.execute(sql).fetchall()
        finally:c.close()
    def test_ordered_delivery_and_atomic_close(self):
        self.add();self.add();seen=[]
        j.drain(self.path,'g',lambda row:seen.append(row['id']) is None)
        self.assertEqual(seen,[1,2]);self.assertEqual(self.rows('SELECT phase FROM handoff_control'),[('closed',)])
        self.assertEqual(self.rows('SELECT state FROM handoff_events'),[('delivered',),('delivered',)])
    def test_uncertain_delivery_never_retried(self):
        self.add();self.add()
        with self.assertRaisesRegex(ValueError,'uncertain'):j.drain(self.path,'g',lambda row:False)
        calls=[]
        with self.assertRaisesRegex(ValueError,'uncertain'):j.drain(self.path,'g',lambda row:calls.append(row))
        self.assertEqual(calls,[]);self.assertEqual(self.rows('SELECT state FROM handoff_events'),[('uncertain',),('queued',)])
    def test_crash_after_claim_is_held(self):
        self.add('dispatching')
        with self.assertRaisesRegex(ValueError,'uncertain'):j.drain(self.path,'g',lambda row:True)
    def test_generation_mismatch_never_dispatches(self):
        self.add()
        with self.assertRaisesRegex(ValueError,'generation'):j.drain(self.path,'other',lambda row:True)
if __name__=='__main__':unittest.main()

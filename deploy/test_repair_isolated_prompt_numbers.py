import sqlite3
import tempfile
import unittest
from pathlib import Path
from repair_isolated_prompt_numbers import repair

class RepairPromptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.db=Path(self.tmp.name)/'db';self.gate=Path(self.tmp.name)/'gate'
        with sqlite3.connect(self.db) as d:
            d.executescript("CREATE TABLE capture_generation(generation);INSERT INTO capture_generation VALUES('g');CREATE TABLE sdk_sessions(id,content_session_id);INSERT INTO sdk_sessions VALUES(1,'legacy/g/1'),(2,'live');CREATE TABLE user_prompts(session_db_id,prompt_number,prompt_text);INSERT INTO user_prompts VALUES(1,9,''),(2,9,'');")
        with sqlite3.connect(self.gate) as d:
            d.executescript("CREATE TABLE handoff_control(id,generation,phase);INSERT INTO handoff_control VALUES(1,'g','capture');CREATE TABLE handoff_events(state,event);INSERT INTO handoff_events VALUES('delivered','observation');")
    def test_repair_preserves_empty_privacy_and_history_and_is_idempotent(self):
        self.assertEqual(repair(self.db,self.gate,'g'),1)
        self.assertEqual(repair(self.db,self.gate,'g'),0)
        with sqlite3.connect(self.db) as d:self.assertEqual(d.execute('SELECT * FROM user_prompts').fetchall(),[(1,9,''),(2,1,'')])
    def test_closed_gate_refused(self):
        with sqlite3.connect(self.gate) as d:d.execute("UPDATE handoff_control SET phase='closed'")
        with self.assertRaisesRegex(ValueError,'capturing'):repair(self.db,self.gate,'g')
    def test_prior_prompt_delivery_refused(self):
        with sqlite3.connect(self.gate) as d:d.execute("INSERT INTO handoff_events VALUES('delivered','session-init')")
        with self.assertRaisesRegex(ValueError,'prompt delivery'):repair(self.db,self.gate,'g')
    def test_multiple_prompts_refused_without_mutation(self):
        with sqlite3.connect(self.db) as d:d.execute("INSERT INTO user_prompts VALUES(2,10,'new')")
        with self.assertRaisesRegex(ValueError,'single inherited'):repair(self.db,self.gate,'g')
        with sqlite3.connect(self.db) as d:self.assertEqual(d.execute('SELECT prompt_number FROM user_prompts WHERE session_db_id=2').fetchall(),[(9,),(10,)])

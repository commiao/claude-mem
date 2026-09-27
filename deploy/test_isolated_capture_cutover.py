import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).parent))
import isolated_capture_cutover as c

class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.old=self.root/'old';self.old.mkdir();self.new=self.root/'new'
        self.bundle=self.root/'worker-service.cjs';self.bundle.write_text('tested artifact')
        self.marker=self.root/'preserved.json';self.marker.write_text('{"pid":123}')
        (self.old/'settings.json').write_text('{"CLAUDE_MEM_WORKER_PORT":"37701","unchanged":"keep"}')
        self.args=SimpleNamespace(stage='capture',legacy_dir=self.old,new_dir=self.new,legacy_port=37701,new_port=37721,legacy_pid=123,generation='g',bundle=[self.bundle],bundle_sha=c.digest(self.bundle),preserve_marker=self.marker)
    def make_prepared(self):
        self.new.mkdir();db=sqlite3.connect(self.new/'claude-mem.db');db.execute('CREATE TABLE capture_generation(generation TEXT)');db.execute("INSERT INTO capture_generation VALUES('g')");db.commit();db.close()
        (self.new/'worker.pid').write_text('{"pid":456,"port":37721}')
        (self.old/'capture-handoff-g.receipt.json').write_text(json.dumps({'phase':'prepared','generation':'g','settings_sha256':c.digest(self.old/'settings.json'),'bundle_sha256':c.digest(self.bundle)}))
        self.args.stage='switch'
    def ready(self,port):return {'pid':123 if port==37701 else 456,'status':'ok','activeSessions':0}
    def test_capture_publishes_only_after_bundle_and_preservation_match(self):
        with patch.object(c,'health',self.ready),patch.object(c,'hooks',return_value={11:'identity'}):c.main(self.args)
        control=json.loads((self.old/'capture-handoff.json').read_text())
        self.assertEqual(control['generation'],'g')
        with sqlite3.connect(control['journal']) as db:self.assertEqual(db.execute('SELECT phase FROM handoff_control').fetchone(),('capture',))
    def test_bundle_mismatch_cannot_publish_gate(self):
        self.args.bundle_sha='wrong'
        with patch.object(c,'health',self.ready),self.assertRaisesRegex(ValueError,'differs'):c.main(self.args)
        self.assertFalse((self.old/'capture-handoff.json').exists())
    def test_switch_checks_pid_artifact_and_preserves_other_settings(self):
        self.make_prepared();response=MagicMock();response.__enter__.return_value.status=200
        with patch.object(c,'health',self.ready),patch.object(c.subprocess,'run',return_value=SimpleNamespace(stdout='/bun '+str(self.bundle))),patch.object(c.urllib.request,'urlopen',return_value=response):c.main(self.args)
        settings=json.loads((self.old/'settings.json').read_text())
        self.assertEqual(settings['CLAUDE_MEM_WORKER_PORT'],'37721');self.assertEqual(settings['unchanged'],'keep')
    def test_rollback_refuses_any_attempted_delivery(self):
        self.make_prepared()
        journal=self.old/'capture-handoff-g.sqlite3'
        c.initialize(journal,'g')
        with sqlite3.connect(journal) as db:
            db.execute("INSERT INTO handoff_events(platform,event,payload,state) VALUES('codex','observation','{}','uncertain')")
        receipt=self.old/'capture-handoff-g.receipt.json';state=json.loads(receipt.read_text());state['phase']='routed';receipt.write_text(json.dumps(state))
        self.args.stage='rollback-routing'
        before=(self.old/'settings.json').read_bytes()
        with patch.object(c,'health',self.ready),self.assertRaisesRegex(ValueError,'already attempted'):c.main(self.args)
        self.assertEqual((self.old/'settings.json').read_bytes(),before)

    def test_foreign_pid_cannot_switch_routing(self):
        self.make_prepared();(self.new/'worker.pid').write_text('{"pid":999,"port":37721}')
        before=(self.old/'settings.json').read_bytes()
        with patch.object(c,'health',self.ready),self.assertRaisesRegex(ValueError,'ownership'):c.main(self.args)
        self.assertEqual((self.old/'settings.json').read_bytes(),before)

if __name__=='__main__':unittest.main()

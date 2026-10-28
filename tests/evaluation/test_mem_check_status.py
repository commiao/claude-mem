import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mem_check', Path(__file__).parents[2] / 'scripts/mem_check.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseIdentityTest(unittest.TestCase):
    def release(self, root, *, name='claude-mem-eval'):
        revision = 'a' * 40
        content = b'published code\n'
        (root / 'sample.py').write_bytes(content)
        (root / 'RELEASE.json').write_text(json.dumps({'name': name, 'commit': revision, 'repo': '/verified/source'}))
        blob = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
        entry = b'100644 blob ' + blob.encode() + b'\tsample.py\0'
        return revision, entry

    def test_published_snapshot_without_git_has_a_verified_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            revision, entry = self.release(root)
            with patch.object(MODULE.subprocess, 'run', side_effect=[
                SimpleNamespace(returncode=128, stdout=''), SimpleNamespace(returncode=0, stdout=entry),
            ]):
                self.assertEqual(MODULE.source_identity(root), (revision, False, 'verified-release-snapshot'))

    def test_release_metadata_cannot_hide_tampered_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, entry = self.release(root)
            (root / 'sample.py').write_text('changed after release\n')
            with patch.object(MODULE.subprocess, 'run', side_effect=[
                SimpleNamespace(returncode=128, stdout=''), SimpleNamespace(returncode=0, stdout=entry),
            ]), self.assertRaisesRegex(RuntimeError, 'bytes differ'):
                MODULE.source_identity(root)

    def test_other_release_surface_is_not_mistaken_for_mem_adapter(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.release(root, name='different-service')
            with (patch.object(MODULE.subprocess, 'run', return_value=SimpleNamespace(returncode=128, stdout='')),
                  self.assertRaisesRegex(RuntimeError, 'invalid')):
                MODULE.source_identity(root)


if __name__ == '__main__':
    unittest.main()

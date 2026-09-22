#!/usr/bin/env python3
"""check_plugin_drift.py 的用例。

全部在临时 git 仓库 + 临时安装目录里跑，显式传 --repo/--install/--ref，
不碰真实 fork 也不碰真实插件目录（准则 17：变异会删掉被测代码的安全闸，
所以沙箱必须由夹具自己提供）。

跑法：python3 deploy/test_check_plugin_drift.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parent))
import check_plugin_drift as cpd  # noqa: E402

REAL_INSTALL = Path("~/.claude/plugins/cache/thedotmack/claude-mem").expanduser()


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args],
                   capture_output=True, text=True, check=True)


class Base(unittest.TestCase):
    FILES = {
        "scripts/worker-service.cjs": "patched-bundle\n",
        "scripts/transcript-watcher.cjs": "upstream-watcher\n",
        "hooks/hooks.json": '{"hooks":{}}\n',
        "modes/code--en.json": '{"mode":"en"}\n',   # 非可执行，默认不比
    }

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cm-drift-"))
        self.repo = self.tmp / "repo"
        (self.repo / "plugin").mkdir(parents=True)
        for rel, body in self.FILES.items():
            path = self.repo / "plugin" / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        git(self.repo.parent, "init", "-q", str(self.repo))
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "plugin tree")
        self.ref = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"],
                                  capture_output=True, text=True, check=True).stdout.strip()

        self.install = self.tmp / "install"
        for rel, body in self.FILES.items():
            path = self.install / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        cpd.KNOWN.pop("scripts/transcript-watcher.cjs", None)
        cpd.KNOWN.pop(".mcp.json", None)

    def run_check(self, *extra):
        return cpd.main(["--repo", str(self.repo), "--ref", self.ref,
                         "--install", str(self.install), *extra])


class ClassificationTests(Base):
    def test_identical_is_clean(self):
        self.assertEqual(self.run_check(), cpd.EXIT_OK)

    def test_patched_file_drift_is_reported(self):
        (self.install / "scripts/worker-service.cjs").write_text("clobbered\n")
        self.assertEqual(self.run_check(), cpd.EXIT_DRIFT)

    def test_upstream_file_drift_is_reported(self):
        (self.install / "scripts/transcript-watcher.cjs").write_text("changed\n")
        self.assertEqual(self.run_check(), cpd.EXIT_DRIFT)

    def test_patched_and_upstream_are_labelled_differently(self):
        """两类的处置相反：补丁掉了要还原，插件升级了还原反而是降级（准则 23）。"""
        (self.install / "scripts/worker-service.cjs").write_text("clobbered\n")
        (self.install / "scripts/transcript-watcher.cjs").write_text("changed\n")
        out = self._capture()
        self.assertIn("[PATCHED ] scripts/worker-service.cjs", out)
        self.assertIn("[UPSTREAM] scripts/transcript-watcher.cjs", out)

    def test_only_prod_executable_is_reported(self):
        """准则 4：只按 git 清单查，永远看不见只在生产上存在的文件。"""
        (self.install / "scripts" / "sneaky.cjs").write_text("hello\n")
        self.assertEqual(self.run_check(), cpd.EXIT_DRIFT)
        self.assertIn("[ONLY_PROD] scripts/sneaky.cjs", self._capture())

    def test_non_executable_drift_ignored_by_default(self):
        (self.install / "modes/code--en.json").write_text('{"mode":"xx"}\n')
        self.assertEqual(self.run_check(), cpd.EXIT_OK)

    def test_non_executable_drift_caught_with_all_files(self):
        (self.install / "modes/code--en.json").write_text('{"mode":"xx"}\n')
        self.assertEqual(self.run_check("--all-files"), cpd.EXIT_DRIFT)

    def _capture(self):
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.run_check()
        return buf.getvalue()


class KnownDeviationTests(Base):
    def test_known_deviation_does_not_fail_but_is_still_printed(self):
        """登记不是豁免：已登记的偏差仍然要出现在输出里（准则 4：要看见）。"""
        cpd.KNOWN["scripts/transcript-watcher.cjs"] = "测试用登记说明"
        (self.install / "scripts/transcript-watcher.cjs").write_text("changed\n")
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_check()
        out = buf.getvalue()
        self.assertEqual(rc, cpd.EXIT_OK)
        self.assertIn("scripts/transcript-watcher.cjs", out)
        self.assertIn("测试用登记说明", out)


class CannotCheckTests(Base):
    def test_missing_install_root_cannot_check(self):
        shutil.rmtree(self.install)
        self.assertEqual(self.run_check(), cpd.EXIT_CANNOT)

    def test_unreadable_provenance_cannot_check_not_drift(self):
        """基准取不到是「查不了」，不是「有漂移」——处置不同。"""
        rc = cpd.main(["--repo", str(self.repo), "--install", str(self.install),
                       "--root", str(self.tmp / "no-such-root")])
        self.assertEqual(rc, cpd.EXIT_CANNOT)


class SandboxSelfCheck(unittest.TestCase):
    def test_real_install_untouched(self):
        if not REAL_INSTALL.exists():
            self.skipTest("本机没有 %s" % REAL_INSTALL)
        sneaky = list(REAL_INSTALL.rglob("sneaky.cjs"))
        self.assertEqual(sneaky, [], "真实插件目录被用例污染了：%s" % sneaky)


if __name__ == "__main__":
    unittest.main(verbosity=2)

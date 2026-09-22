#!/usr/bin/env python3
"""release-patch.sh 的用例，重点是**回滚路径**（准则 6）。

准则 6 的原话：回滚路径的测试必须是绿的，才允许发布。带着没验过的回滚路径切生产
= 没有验证过的退路。而在此之前，这个脚本一条测试都没有 —— 包括它唯一的回滚动作
（拿一个更早的 commit 再跑一次，把 current 指回去）。

## 夹具必须自带沙箱（准则 17）

脚本默认写 `$HOME/.local/share/claude-mem-patch`，而变异验证会把被测代码的安全闸
一起删掉。所以：

  * 每条用例都显式传 `CLAUDE_MEM_PATCH_ROOT=<临时目录>`
  * 每条用例在**临时 git 仓库**里跑，不碰真实 fork
  * 最后一条复核断言真实的发布根目录没有被动过

没有最后那条，一次「变异把 ROOT 默认值改死」的验证就会改写生产产物，而测试还是绿的。

跑法：python3 deploy/test_release_patch.py
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).absolute().parent / "release-patch.sh"
ARTIFACT_REL = "plugin/scripts/worker-service.cjs"
REAL_ROOT = Path(os.path.expanduser("~/.local/share/claude-mem-patch"))


def git(repo, *args, **kw):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True, **kw)


class Harness(unittest.TestCase):
    """一个最小的假 fork：主干上两笔改动产物的提交，外加一条旁支。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cm-release-"))
        self.repo = self.tmp / "repo"
        self.root = self.tmp / "patch-root"
        (self.repo / "plugin" / "scripts").mkdir(parents=True)
        (self.repo / "deploy").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.repo / "deploy" / "release-patch.sh")

        git(self.repo.parent, "init", "-q", str(self.repo))
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        git(self.repo, "checkout", "-q", "-B", "main")

        self.v1 = self._commit("bundle-v1\n", "v1")
        self.v2 = self._commit("bundle-v2\n", "v2")
        # origin/main 必须存在：脚本用它做「只发主干」的闸
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.v2)
        # 一条不在主干上的旁支提交
        git(self.repo, "checkout", "-q", "-b", "side", self.v1)
        self.side = self._commit("bundle-side\n", "side")
        git(self.repo, "checkout", "-q", "main")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _commit(self, content, msg):
        path = self.repo / ARTIFACT_REL
        path.write_text(content, encoding="utf-8")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", msg)
        return git(self.repo, "rev-parse", "HEAD").stdout.strip()

    def release(self, commitish):
        env = dict(os.environ, CLAUDE_MEM_PATCH_ROOT=str(self.root))
        return subprocess.run(["bash", str(self.repo / "deploy" / "release-patch.sh"), commitish],
                              capture_output=True, text=True, env=env)

    def current_content(self):
        return (self.root / "current" / "worker-service.cjs").read_text(encoding="utf-8")

    @staticmethod
    def sha(text):
        return hashlib.sha256(text.encode()).hexdigest()


class RollbackTests(Harness):
    """本文件存在的理由：这条路径此前一次都没被执行过。"""

    def test_rollback_to_earlier_commit_repoints_current(self):
        self.assertEqual(self.release(self.v2).returncode, 0)
        self.assertEqual(self.current_content(), "bundle-v2\n")

        # 回滚：拿更早的 commit 再跑一次
        result = self.release(self.v1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current_content(), "bundle-v1\n",
                         "current 没有指回旧产物 —— 回滚没生效")

    def test_rollback_then_forward_again(self):
        """回滚之后还要能再滚回去，且不重新写已存在的产物。"""
        self.release(self.v2)
        self.release(self.v1)
        result = self.release(self.v2)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.current_content(), "bundle-v2\n")
        self.assertIn("已发布过且内容一致", result.stdout)

    def test_current_is_a_symlink_not_a_copy(self):
        """current 必须是软链。它若变成目录副本，下次切换就只是在改一堆文件，
        原子性没了，而且和 releases/<sha> 的对应关系无从验证。"""
        self.release(self.v2)
        self.assertTrue((self.root / "current").is_symlink())

    def test_second_release_does_not_nest_current_inside_previous(self):
        """钉住脚本注释里记的那个坑：`mv` 不带 -h 会跟随软链，
        把临时链接移进上一个 releases 目录里，而 current 纹丝不动。
        第一次发布看不出来（current 还不存在），第二次起静默失效。"""
        self.release(self.v1)
        self.release(self.v2)
        nested = self.root / "releases" / self.v1[:8] / "current"
        self.assertFalse(nested.exists(), "current 被移进了上一个 release 目录里")
        self.assertEqual(self.current_content(), "bundle-v2\n")


class GateTests(Harness):
    def test_non_trunk_commit_is_refused(self):
        """准则 18：只发主干。旁支上的构建产物曾经真的被发到过生产。"""
        result = self.release(self.side)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不在 origin/main", result.stderr)
        self.assertFalse((self.root / "current").exists(),
                         "被拒绝的发布不该留下 current")

    def test_unresolvable_commitish_is_refused(self):
        result = self.release("no-such-ref")
        self.assertNotEqual(result.returncode, 0)

    def test_existing_release_with_wrong_content_is_refused(self):
        """不可变产物不许就地改写 —— 标签说谎正是这个脚本要防的事。"""
        self.release(self.v2)
        artifact = self.root / "releases" / self.v2[:8] / "worker-service.cjs"
        artifact.write_text("tampered\n", encoding="utf-8")
        result = self.release(self.v2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不可变产物不许就地改写", result.stderr)

    def test_provenance_records_the_commit_and_digest(self):
        self.release(self.v2)
        prov = (self.root / "releases" / self.v2[:8] / "PROVENANCE").read_text()
        self.assertIn("commit=%s" % self.v2, prov)
        self.assertIn("sha256=%s" % self.sha("bundle-v2\n"), prov)


class SandboxSelfCheck(unittest.TestCase):
    """兜底：整轮跑完，真实发布根目录不许被动过（准则 17）。"""

    def test_real_release_root_untouched(self):
        if not REAL_ROOT.exists():
            self.skipTest("本机没有 %s" % REAL_ROOT)
        names = {p.name for p in (REAL_ROOT / "releases").iterdir()}
        self.assertTrue(all(len(n) == 8 for n in names),
                        "真实发布目录里出现了不像 commit 短号的条目：%s" % names)
        for bogus in ("bundle-v1\n", "bundle-v2\n", "bundle-side\n"):
            current = REAL_ROOT / "current" / "worker-service.cjs"
            if current.exists():
                self.assertNotEqual(current.read_text(errors="replace")[:32], bogus,
                                    "真实产物被用例污染了 —— 某条用例没传 CLAUDE_MEM_PATCH_ROOT")


if __name__ == "__main__":
    unittest.main(verbosity=2)

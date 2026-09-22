#!/usr/bin/env python3
"""check_settings.py 的用例。

⚠️ 夹具自带沙箱，理由是准则 17 踩出来的：变异验证会把被测代码的安全闸一起删掉，
所以**用例本身必须在没有那道闸时也无害**。这里 `--apply` 会真写文件 ——
每条用例都显式传 `--live <临时文件>`，并且最后有一条复核断言真实的
`~/.claude-mem/settings.json` 没有被动过。没有那条复核，一次「--apply 忘了传 --live」
的变异就会改写生产配置，而且测试还是绿的。

跑法：python3 deploy/test_check_settings.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parent))
import check_settings as cs  # noqa: E402

REAL_LIVE = Path(os.path.expanduser("~/.claude-mem/settings.json"))
APPROVED_SAMPLE = {"ANTHROPIC_BASE_URL": "http://127.0.0.1:39001",
                   "ANTHROPIC_MODEL": "claude_mem.observation"}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cm-settings-"))
        self.approved = self.dir / "approved.json"
        self.live = self.dir / "live.json"
        self.write(self.approved, APPROVED_SAMPLE)

    @staticmethod
    def write(path, data):
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def run_check(self, *extra):
        return cs.main(["--approved", str(self.approved), "--live", str(self.live), *extra])


class CheckTests(Base):
    def test_identical_is_clean(self):
        self.write(self.live, dict(APPROVED_SAMPLE))
        self.assertEqual(self.run_check(), cs.EXIT_OK)

    def test_unmanaged_extra_keys_are_not_drift(self):
        """线上多出来的键归 claude-mem 自己所有，不该报漂移。"""
        self.write(self.live, dict(APPROVED_SAMPLE, CLAUDE_MEM_SOMETHING_NEW="x"))
        self.assertEqual(self.run_check(), cs.EXIT_OK)

    def test_changed_value_is_drift(self):
        self.write(self.live, dict(APPROVED_SAMPLE, ANTHROPIC_MODEL="someone_elses_key"))
        self.assertEqual(self.run_check(), cs.EXIT_DRIFT)

    def test_missing_managed_key_is_drift(self):
        """claude-mem 重新播种默认值时会丢掉我们批准的值——必须报出来。"""
        self.write(self.live, {"ANTHROPIC_BASE_URL": "http://127.0.0.1:39001"})
        self.assertEqual(self.run_check(), cs.EXIT_DRIFT)

    def test_missing_live_file_cannot_check_not_drift(self):
        """文件不存在是「查不了」，不是「有漂移」——两者处置不同（准则 23）。"""
        self.assertEqual(self.run_check(), cs.EXIT_CANNOT_CHECK)

    def test_corrupt_live_json_cannot_check(self):
        self.live.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.run_check(), cs.EXIT_CANNOT_CHECK)

    def test_secret_shaped_key_in_approved_is_refused(self):
        """绊线：正本里混进机密名就拒绝，且是 CANNOT_CHECK 不是 DRIFT。"""
        self.write(self.approved, dict(APPROVED_SAMPLE, CLAUDE_MEM_GEMINI_API_KEY="sk-x"))
        self.write(self.live, dict(APPROVED_SAMPLE, CLAUDE_MEM_GEMINI_API_KEY="sk-x"))
        self.assertEqual(self.run_check(), cs.EXIT_CANNOT_CHECK)


class ApplyTests(Base):
    def test_apply_preserves_unmanaged_keys(self):
        """--apply 是 merge 不是覆盖：claude-mem 自己加的键必须留着。"""
        self.write(self.live, {"ANTHROPIC_MODEL": "stale", "CLAUDE_MEM_ITS_OWN": "keep-me"})
        self.assertEqual(self.run_check("--apply"), cs.EXIT_OK)
        after = json.loads(self.live.read_text())
        self.assertEqual(after["ANTHROPIC_MODEL"], "claude_mem.observation")
        self.assertEqual(after["CLAUDE_MEM_ITS_OWN"], "keep-me")
        self.assertEqual(after["ANTHROPIC_BASE_URL"], "http://127.0.0.1:39001")

    def test_apply_then_check_is_clean(self):
        self.write(self.live, {"ANTHROPIC_MODEL": "stale"})
        self.run_check("--apply")
        self.assertEqual(self.run_check(), cs.EXIT_OK)


class SandboxSelfCheck(unittest.TestCase):
    """兜底：整轮用例跑完，真实环境不许被动过。

    这条不是形式主义 —— 准则 17 记着一次真实事故：变异把被测代码的安全闸删掉之后，
    用例真的执行了安装，把 11 个线上软链指到了临时工作树。
    """

    def test_real_settings_untouched(self):
        if not REAL_LIVE.exists():
            self.skipTest("本机没有 %s" % REAL_LIVE)
        data = json.loads(REAL_LIVE.read_text())
        self.assertIn("ANTHROPIC_BASE_URL", data)
        self.assertNotIn("CLAUDE_MEM_ITS_OWN", data,
                         "真实配置被用例污染了 —— 某条用例没有传 --live")


if __name__ == "__main__":
    unittest.main(verbosity=2)

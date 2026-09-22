#!/usr/bin/env python3
"""drift_status.py 的用例。

全程写临时状态文件（显式传 --status），不碰真实的
~/.cache/claude-mem/source-drift.status——一个被用例写坏的状态文件会让巡检
播报假结论，而那正是这套东西要防的（准则 28：假红花掉的是可信度）。

跑法：python3 deploy/test_drift_status.py
"""
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parent))
import drift_status as ds  # noqa: E402

REAL_STATUS = Path("~/.cache/claude-mem/source-drift.status").expanduser()


class CombineTests(unittest.TestCase):
    def test_all_ok(self):
        v, d = ds.combine([("配置", ds.OK, ""), ("插件目录", ds.OK, "")])
        self.assertEqual(v, ds.OK)
        self.assertIn("配置 ok", d)

    def test_drift_wins_over_cannot(self):
        """已经拿到的真结论不能被「查不了」藏掉。"""
        v, _ = ds.combine([("配置", ds.DRIFT, "x"), ("插件目录", ds.CANNOT, "y")])
        self.assertEqual(v, ds.DRIFT)

    def test_cannot_wins_over_ok(self):
        """没拿到指纹不能说「没漂」（准则 25）。"""
        v, _ = ds.combine([("配置", ds.OK, ""), ("插件目录", ds.CANNOT, "y")])
        self.assertEqual(v, ds.CANNOT)

    def test_detail_only_lists_the_bad_ones(self):
        _, d = ds.combine([("配置", ds.OK, "fine"), ("插件目录", ds.DRIFT, "坏了")])
        self.assertIn("插件目录", d)
        self.assertNotIn("fine", d)

    def test_detail_has_no_tab(self):
        """详情里混进 TAB 会把三段格式撑成四段，读取侧当场判「读不懂」。"""
        _, d = ds.combine([("配置", ds.DRIFT, "a\tb")])
        self.assertNotIn("\t", d)


class ExitCodeMappingTests(unittest.TestCase):
    def test_three_states_map_one_to_one(self):
        self.assertEqual(ds.verdict_for(0), ds.OK)
        self.assertEqual(ds.verdict_for(1), ds.DRIFT)
        self.assertEqual(ds.verdict_for(2), ds.CANNOT)

    def test_unknown_exit_code_is_cannot_not_ok(self):
        """检查器崩在意料之外的码上（SIGKILL=137、Python 未捕获异常=1 之外的一切），
        绝不能被当成 ok。

        钉的是 verdict_for 本体，不是在用例里照抄一份 `BY_CODE.get(rc, CANNOT)`——
        照抄的那份改坏生产代码时不会转红（准则 17：用例测的是副本，不是本体）。
        """
        for code in (3, 127, 137, -9):
            self.assertEqual(ds.verdict_for(code), ds.CANNOT,
                             "退出码 %s 被判成了 %s" % (code, ds.verdict_for(code)))


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cm-status-"))
        self.path = self.dir / "sub" / "source-drift.status"

    def test_writes_three_tab_separated_fields(self):
        ds.write_status(self.path, ds.OK, "一切正常")
        at, verdict, detail = self.path.read_text().strip().split("\t", 2)
        self.assertEqual(verdict, ds.OK)
        self.assertEqual(detail, "一切正常")
        # 读取侧用 datetime.fromisoformat 解析，解析不了就报「读不懂」
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        self.assertLess(abs((datetime.now(timezone.utc) - parsed).total_seconds()), 60)

    def test_creates_parent_directory(self):
        ds.write_status(self.path, ds.OK, "x")
        self.assertTrue(self.path.exists())

    def test_no_temp_file_left_behind(self):
        """写到一半的文件会被读成「状态读不懂」，等于把一次正常写入播报成故障。"""
        ds.write_status(self.path, ds.OK, "x")
        leftovers = [p.name for p in self.path.parent.iterdir() if ".tmp." in p.name]
        self.assertEqual(leftovers, [])


class ServingCommitTests(unittest.TestCase):
    """判决里必须带线上 bundle 的 commit，否则发布回退巡检默默不覆盖这个服务。

    fleet-ops 的 check-release-regression.py 从判决行里正则取 commit，取不到就报
    「不在覆盖范围内」——而「没覆盖」和「没问题」在输出上长得一模一样。
    """

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cm-patchroot-"))
        (self.dir / "current").mkdir(parents=True)

    def _prov(self, body):
        (self.dir / "current" / "PROVENANCE").write_text(body, encoding="utf-8")

    def test_reads_commit_and_truncates_to_twelve(self):
        self._prov("commit=d03b78efb0655ae74789bd3fcd4cbad4952112c3\nsha256=x\n")
        self.assertEqual(ds.serving_commit(self.dir), "d03b78efb065")

    def test_missing_provenance_returns_none_not_a_crash(self):
        self.assertIsNone(ds.serving_commit(self.dir / "nope"))

    def test_provenance_without_commit_line_returns_none(self):
        self._prov("sha256=x\nbuilt_at=y\n")
        self.assertIsNone(ds.serving_commit(self.dir))


class SandboxSelfCheck(unittest.TestCase):
    def test_real_status_not_written_by_tests(self):
        if not REAL_STATUS.exists():
            self.skipTest("本机还没有 %s" % REAL_STATUS)
        self.assertNotIn("一切正常", REAL_STATUS.read_text(),
                         "真实状态文件被用例污染了 —— 某条用例没传 --status")


if __name__ == "__main__":
    unittest.main(verbosity=2)

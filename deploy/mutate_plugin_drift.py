#!/usr/bin/env python3
"""check_plugin_drift.py 的变异验证。

两道自检，缺一不可（准则 17）：
  1. 改之前断言原文在源码里 —— 「没改进去」和「没抓住」在终端上长得一模一样
  2. 基线必须先绿 —— 红基线上的变异验证是空转

⚠️ deploy/ 下现在有三个几乎相同的 mutate runner（本文件、mutate.py、
mutate_release.py），分别随三条分支进来。**三条都合主干之后应当合成一个**：
抄第二份的代价不是多几行，是三份迟早漂开（准则 30 的同一条）。记在这里别忘。
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).absolute().parent
SRC = HERE / "check_plugin_drift.py"
TESTS = HERE / "test_check_plugin_drift.py"

MUTATIONS = [
    ("M1 PATCHED 与 UPSTREAM 不分类",
     'kind = "PATCHED " if rel in PATCHED_FILES else "UPSTREAM"',
     'kind = "UPSTREAM"'),
    ("M2 已登记的偏差直接跳过不打印（登记变成静音）",
     '            note = KNOWN.get(rel)\n            mark = "•" if note else "❌"',
     '            note = KNOWN.get(rel)\n            if note:\n                continue\n            mark = "❌"'),
    ("M3 不报「只在生产上存在」的文件（准则 4）",
     "        for rel in only_prod:",
     "        for rel in []:"),
    ("M4 基准取不到时当成没漂移，而不是「查不了」",
     '        raise Cannot("读不到 %s（%s）—— 还没发布过？" % (prov, exc))',
     '        return "HEAD"'),
    ("M5 去掉「只比会被执行的文件」这道过滤",
     "        if executable_only and not EXECUTABLE.search(rel):",
     "        if False:"),
]


def run_tests():
    return subprocess.run([sys.executable, str(TESTS)],
                          capture_output=True, text=True).returncode


def main():
    original = SRC.read_text(encoding="utf-8")
    backup = SRC.with_suffix(".py.bak")
    shutil.copy2(SRC, backup)

    print("基线：", end=" ", flush=True)
    if run_tests() != 0:
        print("❌ 红 —— 先修基线")
        backup.unlink()
        return 1
    print("✅ 绿")

    failures = []
    try:
        for name, before, after in MUTATIONS:
            if before not in original:
                print("⚠️  %-46s 原文不在源码里 —— 没改进去，这条作废" % name)
                failures.append(name)
                continue
            SRC.write_text(original.replace(before, after, 1), encoding="utf-8")
            ok = run_tests() != 0
            print("%-48s %s" % (name, "✅ 转红" if ok else "❌ 仍绿 —— 无人钉住"))
            if not ok:
                failures.append(name)
    finally:
        shutil.copy2(backup, SRC)
        backup.unlink()

    same = SRC.read_text(encoding="utf-8") == original
    print("\n源码已还原：%s" % ("✅" if same else "❌ 还原失败！"))
    print("结果：%d/%d 转红" % (len(MUTATIONS) - len(failures), len(MUTATIONS)))
    return 0 if not failures and same else 1


if __name__ == "__main__":
    sys.exit(main())

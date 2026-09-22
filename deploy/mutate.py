#!/usr/bin/env python3
"""变异验证：把被测代码逐处改坏，用例必须当场转红。

两道自检，缺一不可（准则 17）：
  1. 改之前断言原文在源码里 —— 否则「没改进去」会被读成「没抓住」
  2. 基线必须先绿 —— 基线本身是红的话，变异后也红什么都证明不了
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).absolute().parent
SRC = HERE / "check_settings.py"
TESTS = HERE / "test_check_settings.py"

MUTATIONS = [
    ("M1 线上多出的键也算漂移",
     "    missing, differing = [], []",
     "    missing, differing = [k for k in live if k not in approved], []"),
    ("M2 线上文件缺失时报 DRIFT 而非 CANNOT_CHECK",
     '        raise Cannot("%s 不存在：%s" % (label, path))',
     "        return {}"),
    ("M3 --apply 整份覆盖，丢掉不纳管的键",
     "        merged = dict(live)\n        merged.update(approved)",
     "        merged = dict(approved)"),
    ("M4 去掉正本的机密绊线",
     "    return sorted(k for k in approved if SECRET_SHAPED.search(k))",
     "    return []"),
    ("M5 只比键不比值",
     "        elif live[key] != want:",
     "        elif False:"),
]


def run_tests():
    proc = subprocess.run([sys.executable, str(TESTS)],
                          capture_output=True, text=True)
    return proc.returncode


def main():
    original = SRC.read_text(encoding="utf-8")
    backup = SRC.with_suffix(".py.bak")
    shutil.copy2(SRC, backup)

    print("基线：", end=" ", flush=True)
    base_rc = run_tests()
    if base_rc != 0:
        print("❌ 红 —— 变异验证在红基线上没有意义，先修基线")
        backup.unlink()
        return 1
    print("✅ 绿")

    failures = []
    try:
        for name, before, after in MUTATIONS:
            if before not in original:
                print("⚠️  %-42s 原文不在源码里 —— 变异没改进去，这条作废" % name)
                failures.append(name)
                continue
            SRC.write_text(original.replace(before, after, 1), encoding="utf-8")
            rc = run_tests()
            ok = rc != 0
            print("%-44s %s" % (name, "✅ 转红" if ok else "❌ 仍绿 —— 没有用例钉住它"))
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

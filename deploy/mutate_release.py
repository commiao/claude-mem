#!/usr/bin/env python3
"""release-patch.sh 的变异验证。规矩同 mutate.py：先断言原文在、先确认基线绿。"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).absolute().parent
SRC = HERE / "release-patch.sh"
TESTS = HERE / "test_release_patch.py"

MUTATIONS = [
    ("M1 去掉「只发主干」那道闸",
     'git -C "$REPO" merge-base --is-ancestor "$resolved" origin/main \\\n  || fail',
     'true \\\n  || fail'),
    ("M2 mv 去掉 -h（跟随软链，第二次发布起静默失效）",
     'mv -fh -- "$link_tmp" "${ROOT}/current"',
     'mv -f -- "$link_tmp" "${ROOT}/current"'),
    ("M3 允许就地改写已存在的不可变产物",
     '|| fail "${target} 已存在且内容与该 commit 不符；不可变产物不许就地改写"',
     '|| true'),
    ("M4 current 改成目录副本而非软链",
     'ln -sfn -- "$target" "$link_tmp"\nmv -fh -- "$link_tmp" "${ROOT}/current"',
     'rm -rf -- "${ROOT}/current"\ncp -R -- "$target" "${ROOT}/current"'),
    ("M5 已发布过就直接退出，不切 current（回滚会失效）",
     '  say "  该版本已发布过且内容一致，跳过写入"',
     '  say "  该版本已发布过且内容一致，跳过写入"; exit 0'),
]


def run_tests():
    return subprocess.run([sys.executable, str(TESTS)],
                          capture_output=True, text=True).returncode


def main():
    original = SRC.read_text(encoding="utf-8")
    backup = SRC.with_suffix(".sh.bak")
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

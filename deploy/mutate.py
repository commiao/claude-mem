#!/usr/bin/env python3
"""变异验证：把被测代码逐处改坏，对应用例必须当场转红。

## 为什么是一个文件而不是三个

三条分支各带了一个几乎相同的 runner（mutate.py / mutate_release.py /
mutate_plugin_drift.py），合主干后立刻合成这一个。抄第二份的代价不是多几行 ——
**两份迟早漂开，而漂开的那一份会在它自己也说不清的时候放行或拒绝**（准则 30）。
三份更快。

## 两道自检，缺一不可（准则 17）

1. **改之前断言原文在源码里。** 「没改进去」和「没抓住」在终端上长得一模一样，
   混了就会得出「这条没测到」的假结论，然后去补一条其实早就存在的用例。
2. **基线必须先绿。** 红基线上的变异验证是空转 —— 变异后也红，什么都没证明。

## 用法

    python3 deploy/mutate.py           # 全部三个目标
    python3 deploy/mutate.py drift     # 只跑一个
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).absolute().parent

TARGETS = {
    "settings": {
        "src": "check_settings.py",
        "tests": "test_check_settings.py",
        "mutations": [
            ("线上多出的键也算漂移",
             "    missing, differing = [], []",
             "    missing, differing = [k for k in live if k not in approved], []"),
            ("线上文件缺失时报 DRIFT 而非 CANNOT_CHECK",
             '        raise Cannot("%s 不存在：%s" % (label, path))',
             "        return {}"),
            ("--apply 整份覆盖，丢掉不纳管的键",
             "        merged = dict(live)\n        merged.update(approved)",
             "        merged = dict(approved)"),
            ("去掉正本的机密绊线",
             "    return sorted(k for k in approved if SECRET_SHAPED.search(k))",
             "    return []"),
            ("只比键不比值",
             "        elif live[key] != want:",
             "        elif False:"),
        ],
    },
    "release": {
        "src": "release-patch.sh",
        "tests": "test_release_patch.py",
        "mutations": [
            ("去掉「只发主干」那道闸",
             'git -C "$REPO" merge-base --is-ancestor "$resolved" origin/main \\\n  || fail',
             'true \\\n  || fail'),
            ("mv 去掉 -h（跟随软链，第二次发布起静默失效）",
             'mv -fh -- "$link_tmp" "${ROOT}/current"',
             'mv -f -- "$link_tmp" "${ROOT}/current"'),
            ("允许就地改写已存在的不可变产物",
             '|| fail "${target} 已存在且内容与该 commit 不符；不可变产物不许就地改写"',
             '|| true'),
            ("current 改成目录副本而非软链",
             'ln -sfn -- "$target" "$link_tmp"\nmv -fh -- "$link_tmp" "${ROOT}/current"',
             'rm -rf -- "${ROOT}/current"\ncp -R -- "$target" "${ROOT}/current"'),
            ("已发布过就直接退出，不切 current（回滚会失效）",
             '  say "  该版本已发布过且内容一致，跳过写入"',
             '  say "  该版本已发布过且内容一致，跳过写入"; exit 0'),
        ],
    },
    "drift": {
        "src": "check_plugin_drift.py",
        "tests": "test_check_plugin_drift.py",
        "mutations": [
            ("PATCHED 与 UPSTREAM 不分类",
             'kind = "PATCHED " if rel in PATCHED_FILES else "UPSTREAM"',
             'kind = "UPSTREAM"'),
            ("已登记的偏差直接跳过不打印（登记变成静音）",
             '            note = KNOWN.get(rel)\n            mark = "•" if note else "❌"',
             '            note = KNOWN.get(rel)\n            if note:\n                continue\n            mark = "❌"'),
            ("不报「只在生产上存在」的文件（准则 4）",
             "        for rel in only_prod:",
             "        for rel in []:"),
            ("基准取不到时当成没漂移，而不是「查不了」",
             '        raise Cannot("读不到 %s（%s）—— 还没发布过？" % (prov, exc))',
             '        return "HEAD"'),
            ("去掉「只比会被执行的文件」这道过滤",
             "        if executable_only and not EXECUTABLE.search(rel):",
             "        if False:"),
        ],
    },
}


def run_tests(tests):
    return subprocess.run([sys.executable, str(HERE / tests)],
                          capture_output=True, text=True).returncode


def run_target(name, spec):
    src = HERE / spec["src"]
    original = src.read_text(encoding="utf-8")
    backup = src.with_name(src.name + ".bak")
    shutil.copy2(src, backup)

    print("\n=== %s（%s）===" % (name, spec["src"]))
    print("基线：", end=" ", flush=True)
    if run_tests(spec["tests"]) != 0:
        print("❌ 红 —— 红基线上的变异验证是空转，先修基线")
        backup.unlink()
        return 1
    print("✅ 绿")

    failures = []
    try:
        for label, before, after in spec["mutations"]:
            if before not in original:
                print("⚠️  %-44s 原文不在源码里 —— 没改进去，这条作废" % label)
                failures.append(label)
                continue
            src.write_text(original.replace(before, after, 1), encoding="utf-8")
            ok = run_tests(spec["tests"]) != 0
            print("%-46s %s" % (label, "✅ 转红" if ok else "❌ 仍绿 —— 无人钉住"))
            if not ok:
                failures.append(label)
    finally:
        shutil.copy2(backup, src)
        backup.unlink()

    if src.read_text(encoding="utf-8") != original:
        print("❌ 源码还原失败！")
        return 1
    print("%d/%d 转红，源码已还原 ✅" % (len(spec["mutations"]) - len(failures),
                                        len(spec["mutations"])))
    return 1 if failures else 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    unknown = [a for a in argv if a not in TARGETS]
    if unknown:
        print("未知目标 %s；可选：%s" % (", ".join(unknown), ", ".join(TARGETS)),
              file=sys.stderr)
        return 2
    names = argv or list(TARGETS)
    bad = sum(run_target(n, TARGETS[n]) for n in names)
    total = sum(len(TARGETS[n]["mutations"]) for n in names)
    print("\n%s（%d 个目标 / %d 处变异）"
          % ("✅ 全部转红" if bad == 0 else "❌ 有未被钉住的变异", len(names), total))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

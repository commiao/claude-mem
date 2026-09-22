#!/usr/bin/env python3
"""把 claude-mem 的两个检查汇成一行状态，供 fleet-ops 的 SessionStart 巡检读。

## 为什么是状态文件而不是让巡检直接调检查器

fleet-ops 的巡检只读 `~/.cache/<name>/source-drift.status`，不调被检查仓库的
可执行物。这是准则 32 的形态：**作业不跑，状态文件就过期，巡检照样出声**
（它按 36 小时判停更）。若改成会话时直接调检查器，那就变成「检查依赖被检查的
那样东西」——claude-mem-fork 没检出时它会安静地什么都不报。

格式与其余四个服务一致，一行三段 TAB 分隔：

    <ISO8601 UTC>\t<ok|drift|cannot>\t<一行详情>

读取侧的词表只有三档：`ok` / `drift` / 其他都当「查不了」。

## 合并两个检查的判据

    任一 drift          → drift    （知道漂了，这是可处置的结论）
    否则任一 cannot     → cannot   （不知道，明确说不知道）
    全 ok               → ok

**drift 压过 cannot**：若配置漂了而插件检查恰好查不了，报「查不了」会把一个
已经拿到的真结论藏掉。反过来不成立——没拿到指纹就不能说「没漂」（准则 25）。

## 原子写

先写临时文件再 rename。读取侧解析失败会报「状态读不懂」，而一个写到一半的文件
正好长那样——那会把一次正常的写入播报成一条故障（准则 28：假红花掉的是
这张网以后还有没有人看）。
"""
import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).absolute().parent
STATUS_DEFAULT = Path("~/.cache/claude-mem/source-drift.status").expanduser()

OK, DRIFT, CANNOT = "ok", "drift", "cannot"
# 子检查的退出码 → verdict。与 check_settings / check_plugin_drift 的三态一致。
BY_CODE = {0: OK, 1: DRIFT, 2: CANNOT}


def verdict_for(returncode):
    """退出码 → verdict。意料之外的码一律 cannot，**绝不落到 ok**。

    单独抽成函数是为了能被用例直接钉住：写在调用处的 `BY_CODE.get(rc, CANNOT)`
    里那个兜底值，用例只能照抄一份来断言，而照抄的那份改坏生产代码时不会转红
    （准则 17：用例测的是副本，不是本体）。
    """
    return BY_CODE.get(returncode, CANNOT)


def run(script, extra):
    proc = subprocess.run([sys.executable, str(HERE / script), *extra],
                          capture_output=True, text=True)
    tail = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ln.strip()]
    return verdict_for(proc.returncode), (tail[-1].strip() if tail else "（无输出）")


def serving_commit(patch_root=None):
    """生产在跑的那个 bundle 出自哪个 commit（读 claude-mem-patch 的 PROVENANCE）。

    为什么判决里必须带这个 sha：fleet-ops 的**发布回退巡检**
    （`bin/check-release-regression.py`）从这行判决里正则取 commit，取不到就报
    「这个服务不在覆盖范围内」——而「没覆盖」和「没问题」在输出上长得一模一样。

    带的是 **bundle 的 commit 而不是本仓库的**：能悄悄倒退、且倒退了会真出事的，
    是生产在跑的那份 3.2MB 产物（2026-09-22 credvault 网关就被换回过一个更早的
    commit，抹掉一项刚上线的额度保护，而三道判据全绿）。
    """
    root = Path(patch_root or "~/.local/share/claude-mem-patch").expanduser()
    try:
        text = (root / "current" / "PROVENANCE").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("commit="):
            return line.split("=", 1)[1].strip()[:12]
    return None


def combine(results):
    """results: [(name, verdict, detail)]"""
    if any(v == DRIFT for _, v, _ in results):
        worst = DRIFT
    elif any(v == CANNOT for _, v, _ in results):
        worst = CANNOT
    else:
        worst = OK
    if worst == OK:
        detail = "；".join("%s ok" % n for n, _, _ in results)
    else:
        detail = "；".join("%s %s：%s" % (n, v, d)
                          for n, v, d in results if v != OK)
    return worst, detail.replace("\t", " ")


def write_status(path, verdict, detail):
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    tmp = path.with_name(path.name + ".tmp.%d" % os.getpid())
    tmp.write_text("%s\t%s\t%s\n" % (stamp, verdict, detail), encoding="utf-8")
    os.replace(str(tmp), str(path))
    return stamp


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True,
                        help="被检查的 claude-mem-fork 工作树（检查器自己跑发布产物）")
    parser.add_argument("--status", default=str(STATUS_DEFAULT))
    parser.add_argument("--patch-root", default=None,
                        help="bundle 产物根（默认 ~/.local/share/claude-mem-patch）")
    args = parser.parse_args(argv)

    results = [
        ("配置",) + run("check_settings.py", []),
        ("插件目录",) + run("check_plugin_drift.py", ["--repo", args.repo]),
    ]
    verdict, detail = combine(results)
    sha = serving_commit(args.patch_root)
    if sha:
        detail = "%s %s" % (sha, detail)
    else:
        # 取不到就说出来：没有 sha 的那行会让发布回退巡检默默不覆盖这个服务。
        detail = "（取不到线上 bundle 的 commit）%s" % detail
    stamp = write_status(Path(args.status), verdict, detail)
    print("%s\t%s\t%s" % (stamp, verdict, detail))
    # 作业本身总是成功退出：它的职责是**写下判决**，不是替巡检做判断。
    # 非零退出会让 launchd 的 last exit status 变成噪音，而真正的信号在文件里。
    return 0


if __name__ == "__main__":
    sys.exit(main())

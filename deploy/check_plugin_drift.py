#!/usr/bin/env python3
"""claude-mem 插件目录的漂移检测（准则 3 / 准则 4）。

## 补的是哪个洞

此前 claude-mem 这条线上唯一被纳管的文件是 `plugin/scripts/worker-service.cjs`
（release-patch.sh 发它、claude_mem_patch_guard.sh 守它）。而插件目录里
**12 个会被执行的文件**里其余 11 个没有任何东西在看。

准则 3 的原话：检测范围要覆盖「会被执行的一切」，不只是「进镜像的」。
第一次跑就抓到两条（见文件末尾的 KNOWN 说明）。

## 三类，处置完全不同，所以分开报（准则 23）

    PATCHED    我们打了补丁的文件与记录不符  → 补丁掉了或被覆盖，该让守护还原
    UPSTREAM   上游文件与记录不符            → 插件升级了，或有人手改了插件目录；
                                              前者要重新移植补丁并重发，后者要查人
    ONLY_PROD  只在生产上存在的文件          → 准则 4：只按 git 清单查永远看不见它们

前两类混报会让人做出相反的动作：补丁掉了要还原，插件升级了**还原反而是降级**
（那正是补丁守护里最要紧的那条闸）。

## 比对基准取 PROVENANCE，不取「当前主干」

基准是**我们实际发布出去的那个 commit**（`current/PROVENANCE` 里的 commit），
不是 origin/main。理由是准则 32：判据要有一个说得出名字的出处。拿主干当基准的话，
主干一往前走，全部文件都会报漂移，而生产什么都没变。

## 退出码

    0  一致（或只有已登记的已知偏差）
    1  有漂移
    2  查不了（基准取不到、插件目录不存在、git 不可用）
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_DEFAULT = Path(__file__).absolute().parent.parent
ROOT_DEFAULT = Path("~/.local/share/claude-mem-patch").expanduser()
PATCHED_FILES = {"scripts/worker-service.cjs"}

# 已登记的已知偏差。每条都要写**为什么**，否则它就是个静音开关。
# 登记不是豁免：这些仍然会被打印，只是不计入退出码。
KNOWN = {
    ".mcp.json": "本机刻意禁用（安装目录里是 .mcp.json.disabled）——待确认这是谁、何时、为什么禁的",
    "scripts/transcript-watcher.cjs": "三个安装根彼此一致而与 fork 记录不符（266428 vs 266386 字节），"
                                      "疑似 marketplace 发行版与 fork 里那份构建产物不同；待查实",
}

EXIT_OK, EXIT_DRIFT, EXIT_CANNOT = 0, 1, 2
EXECUTABLE = re.compile(r"\.(cjs|js|mjs)$|(^|/)hooks\.json$|(^|/)\.mcp\.json$")


class Cannot(Exception):
    pass


def git(repo, *args):
    proc = subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise Cannot("git %s 失败：%s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout


def released_commit(root):
    prov = root / "current" / "PROVENANCE"
    try:
        text = prov.read_text(encoding="utf-8")
    except OSError as exc:
        raise Cannot("读不到 %s（%s）—— 还没发布过？" % (prov, exc))
    for line in text.splitlines():
        if line.startswith("commit="):
            return line.split("=", 1)[1].strip()
    raise Cannot("%s 里没有 commit= 这一行" % prov)


def tracked_blobs(repo, ref):
    """ref 上 plugin/ 下每个文件的 blob 指纹。"""
    out = git(repo, "ls-tree", "-r", ref, "--", "plugin/")
    blobs = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        blobs[path[len("plugin/"):]] = meta.split()[2]
    return blobs


def blob_of(path):
    """算一个磁盘文件的 git blob 指纹，用 git 自己算，不手搓 header（准则 27）。"""
    proc = subprocess.run(["git", "hash-object", str(path)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise Cannot("hash-object 失败：%s" % proc.stderr.strip())
    return proc.stdout.strip()


def scan(install_root, tracked, executable_only):
    """返回 (差异列表, 只在生产上存在的列表)。"""
    differing, only_prod = [], []
    for rel, want in sorted(tracked.items()):
        if executable_only and not EXECUTABLE.search(rel):
            continue
        path = install_root / rel
        if not path.is_file():
            differing.append((rel, "生产上没有这个文件"))
            continue
        if blob_of(path) != want:
            differing.append((rel, "内容不符"))
    for path in sorted(install_root.rglob("*")):
        if not path.is_file():
            continue
        rel = str(path.relative_to(install_root))
        if rel in tracked or not EXECUTABLE.search(rel):
            continue
        if any(part in {"node_modules", ".git"} for part in path.parts):
            continue
        only_prod.append(rel)
    return differing, only_prod


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(REPO_DEFAULT))
    parser.add_argument("--root", default=str(ROOT_DEFAULT),
                        help="发布根目录，用来读 current/PROVENANCE 取基准 commit")
    parser.add_argument("--install", action="append", default=None,
                        help="插件安装根（可多次给）")
    parser.add_argument("--ref", default=None, help="显式指定基准 commit，跳过 PROVENANCE")
    parser.add_argument("--all-files", action="store_true",
                        help="比对全部被跟踪文件，而不只是会被执行的那些")
    args = parser.parse_args(argv)

    # 三个安装根都要查：worker 由哪一个拉起取决于开机时谁先抢到端口，
    # 只查一个等于「检测范围没覆盖会被执行的一切」（准则 3）。
    # 用 glob 而不是写死版本号 —— 写死版本号在插件升级后会静默失效
    # （kg-hub 2026-09-10 写死 13.24.5、09-12 升级后监管名存实亡）。
    if args.install:
        installs = [Path(p).expanduser() for p in args.install]
    else:
        installs = sorted(
            p for pattern in (
                "~/.claude/plugins/cache/thedotmack/claude-mem/*",
                "~/.codex/plugins/cache/claude-mem-local/claude-mem/*",
            )
            for p in Path(pattern).expanduser().parent.glob(Path(pattern).name)
            if p.is_dir() and not (p / ".orphaned_at").exists()
        )
        marketplace = Path("~/.claude/plugins/marketplaces/thedotmack/plugin").expanduser()
        if marketplace.is_dir():
            installs.append(marketplace)
    if not installs:
        print("⚠️  查不了：一个安装根都没找到", file=sys.stderr)
        return EXIT_CANNOT

    try:
        ref = args.ref or released_commit(Path(args.root).expanduser())
        tracked = tracked_blobs(Path(args.repo), ref)
    except Cannot as exc:
        print("⚠️  查不了：%s" % exc, file=sys.stderr)
        return EXIT_CANNOT

    print("基准 %s（plugin/ 下 %d 个被跟踪文件）" % (ref[:8], len(tracked)))
    hard = 0
    for install in installs:
        if not install.is_dir():
            print("⚠️  查不了：安装根不存在 %s" % install, file=sys.stderr)
            return EXIT_CANNOT
        differing, only_prod = scan(install, tracked, not args.all_files)
        print("\n%s" % install)
        if not differing and not only_prod:
            print("  ✅ 一致")
            continue
        for rel, why in differing:
            kind = "PATCHED " if rel in PATCHED_FILES else "UPSTREAM"
            note = KNOWN.get(rel)
            mark = "•" if note else "❌"
            print("  %s [%s] %s —— %s" % (mark, kind, rel, why))
            if note:
                print("        已登记：%s" % note)
            else:
                hard += 1
        for rel in only_prod:
            note = KNOWN.get(rel)
            print("  %s [ONLY_PROD] %s%s"
                  % ("•" if note else "❌", rel, "（已登记）" if note else ""))
            if not note:
                hard += 1
    print("\n%s" % ("✅ 无未登记的漂移" if hard == 0 else "❌ %d 处未登记的漂移" % hard))
    return EXIT_OK if hard == 0 else EXIT_DRIFT


if __name__ == "__main__":
    sys.exit(main())

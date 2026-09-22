#!/usr/bin/env python3
"""claude-mem 运行配置的「已批准 vs 线上」比对（准则 19）。

## 为什么需要它

`~/.claude-mem/settings.json` 决定 claude-mem 的全部运行行为：走哪个网关
(`ANTHROPIC_BASE_URL`)、用哪个业务键计费 (`ANTHROPIC_MODEL`)、worker 监听哪个端口、
哪些项目不采集。**每一个键改了线上行为都会变，而它此前不在任何一个仓库里。**

后果不是"少备份了一个文件"，是**不存在「已批准的配置」这个东西** —— 只有
"这台机器上当下那一份"。谁改了、改成什么、是否被审阅过，事后无从判断；
而那个 `ANTHROPIC_MODEL=claude_mem.observation` 决定了钱走哪条路由。

## 白名单，不是黑名单（准则 12）

正本 `settings.approved.json` **只收白名单里的键**，不是"排除掉机密键之后的全部"。
按「漏掉的后果」选：

    白名单漏一个键  →  少纳管一个配置项，无害，下次补上
    黑名单漏一个键  →  机密进 git

而这不是假想：claude-mem 的 schema 里有 6 个真机密字段
（`CLAUDE_MEM_GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `CHROMA_API_KEY` /
`CLOUD_SYNC_TOKEN` / `TV_TOKEN` / `PRO_MEMORY_KEY`）。当前线上一个都没有，
**但 `SettingsDefaultsManager.loadFromFile` 在文件不存在时会播种全部默认值** ——
也就是说它们随时可能出现。黑名单必须跟着上游 schema 追，白名单不用。

⚠️ 下面那个按名字认机密的检查是**绊线，不是防线**（准则 22：读行为不读名字）。
真正挡住机密的是白名单本身。绊线只防一种情况：将来有人往白名单里手工加了个
带 KEY/TOKEN 字样的键。别把它当成安全边界。

## 为什么是 merge 而不是覆盖

`SettingsDefaultsManager.loadFromFile` 会 `writeJsonFileAtomic` 回写这个文件
（文件缺失时播种、需要扁平化时重写）。**这个文件归 claude-mem 所有**，它随时
可能往里加键。所以：

- 不能用软链指向不可变产物 —— 原子写是 write-temp + rename，会把软链换掉
- `--apply` 只覆盖白名单里那些键，其余原样保留

## 退出码三态

    0  一致
    1  有漂移（白名单里的键，线上与正本不符或缺失）
    2  查不了（文件缺失、JSON 坏、正本自身违规）

第三态必须与第一态分开：检查器自己崩在 Python 异常上也是 rc=1，
和「发现漂移」撞号，只看退出码会把一次工具故障播报成一条硬伤。
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

APPROVED = Path(__file__).absolute().parent / "settings.approved.json"
LIVE_DEFAULT = Path(os.path.expanduser("~/.claude-mem/settings.json"))

# 绊线：白名单里不该出现长得像机密的键名。不是防线，见模块注释。
SECRET_SHAPED = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSPHRASE)$")

EXIT_OK, EXIT_DRIFT, EXIT_CANNOT_CHECK = 0, 1, 2


def load_json(path, label):
    """读一个 JSON 文件；读不了就是「查不了」，不是「有漂移」。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise Cannot("%s 不存在：%s" % (label, path))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise Cannot("%s 不是合法 JSON（%s）：%s" % (label, exc, path))


class Cannot(Exception):
    """判不了，区别于「判出问题」。"""


def audit_approved(approved):
    """正本自身的绊线检查。"""
    return sorted(k for k in approved if SECRET_SHAPED.search(k))


def compare(approved, live):
    """只比白名单里的键。线上多出来的键不管 —— 那是 claude-mem 自己的。"""
    missing, differing = [], []
    for key, want in sorted(approved.items()):
        if key not in live:
            missing.append(key)
        elif live[key] != want:
            differing.append((key, want, live[key]))
    return missing, differing


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--live", default=str(LIVE_DEFAULT),
                        help="线上配置路径（默认 ~/.claude-mem/settings.json）")
    parser.add_argument("--approved", default=str(APPROVED), help="正本路径")
    parser.add_argument("--apply", action="store_true",
                        help="把白名单里的键写回线上（其余键原样保留）")
    args = parser.parse_args(argv)

    try:
        approved = load_json(Path(args.approved), "正本")
        offenders = audit_approved(approved)
        if offenders:
            print("❌ 正本里出现了名字像机密的键，拒绝继续：%s" % ", ".join(offenders),
                  file=sys.stderr)
            return EXIT_CANNOT_CHECK
        live_path = Path(args.live)
        live = load_json(live_path, "线上配置")
    except Cannot as exc:
        print("⚠️  查不了：%s" % exc, file=sys.stderr)
        return EXIT_CANNOT_CHECK

    missing, differing = compare(approved, live)

    if args.apply:
        if not missing and not differing:
            print("✅ 已一致，未改动 %s" % live_path)
            return EXIT_OK
        merged = dict(live)
        merged.update(approved)
        tmp = live_path.with_suffix(".json.tmp.%d" % os.getpid())
        tmp.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
        os.replace(str(tmp), str(live_path))
        print("✅ 已把 %d 个键写回 %s（保留了 %d 个不纳管的键）"
              % (len(approved), live_path, len(set(live) - set(approved))))
        return EXIT_OK

    if not missing and not differing:
        print("✅ 线上与已批准的配置一致（%d 个纳管键，%d 个不纳管）"
              % (len(approved), len(set(live) - set(approved))))
        return EXIT_OK

    for key in missing:
        print("❌ 线上缺少纳管键 %s（应为 %r）" % (key, approved[key]))
    for key, want, got in differing:
        print("❌ %s 不符：已批准 %r，线上 %r" % (key, want, got))
    print("→ 确认线上那份是对的就更新正本并提交；确认正本是对的就跑 --apply")
    return EXIT_DRIFT


if __name__ == "__main__":
    sys.exit(main())

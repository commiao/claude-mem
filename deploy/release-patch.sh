#!/usr/bin/env bash
# 把打了补丁的 worker bundle 按 commit 发布成不可变产物，并原子切换 current。
#
# ## 为什么需要它
#
# 在这之前，这个补丁的上线方式是**手工 cp**。代价当天就显形了四次
# （T-0096 逐条记着），其中两次直接由"没有发布脚本"造成：
#
# - 发过一个**分支上**的构建产物到生产（`t0077/stable-operation-id`，当时未合主干）。
#   手工 cp 那一步不会问你 commit 在哪、在不在主干上。
# - 产物目录标着 `releases/b9f9263a`，而那个 commit 里的同名文件是**另一份**
#   （`d4677803` vs 实际的 `219b813c`）。标签说谎，而没有任何东西会发现。
#
# 准则 18 的原话：**没有发布脚本的部署路径，等于没有任何准则。**
# 所以这个脚本存在的意义不是"方便"，是让那几条闸有地方可装。
#
# ## 它只做三件事，刻意不做更多
#
#   1. 拒绝非主干：`git merge-base --is-ancestor <sha> origin/main`
#   2. 产物从 **git** 取，不从工作区打包 —— 否则"发布物等于某个 commit"是句空话
#   3. 落地后重算 sha256 与 git 里的 blob 比对，不符就还原、不切 current
#
# 它**不负责**安装到插件目录：那一步由 kg-hub 的 claude_mem_patch_guard.sh 按
# 清单做（它读 current/ 这个稳定入口）。两者的分工是刻意的 —— 插件管理器会覆盖
# 安装位置，所以那边需要一个持续的守护，而这边只需要一次不可变发布。
set -euo pipefail

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARTIFACT="plugin/scripts/worker-service.cjs"
ROOT="${CLAUDE_MEM_PATCH_ROOT:-$HOME/.local/share/claude-mem-patch}"
COMMITISH="${1:-origin/main}"

say() { printf '%s\n' "$1"; }
fail() { printf '❌ %s\n' "$1" >&2; exit 1; }

resolved=$(git -C "$REPO" rev-parse --verify "${COMMITISH}^{commit}") \
  || fail "解析不出 ${COMMITISH}"
short=${resolved:0:8}

# 准则 18：只发主干。用 is-ancestor 而不是「等于 origin/main」——
# 回滚到更早的 commit 是正当操作，只要它确实在主干这条线上。
git -C "$REPO" merge-base --is-ancestor "$resolved" origin/main \
  || fail "${short} 不在 origin/main 这条线上；先合回主干再发"

expected=$(git -C "$REPO" show "${resolved}:${ARTIFACT}" | shasum -a 256 | cut -d' ' -f1) \
  || fail "取不到 ${resolved}:${ARTIFACT}"

say "发布 ${short}（产物 ${ARTIFACT}）"
say "  应有指纹 ${expected:0:16}…"

target="${ROOT}/releases/${short}"
if [ -e "$target" ]; then
  landed_existing=$(shasum -a 256 "${target}/$(basename "$ARTIFACT")" | cut -d' ' -f1)
  [ "$landed_existing" = "$expected" ] \
    || fail "${target} 已存在且内容与该 commit 不符；不可变产物不许就地改写"
  say "  该版本已发布过且内容一致，跳过写入"
else
  staging="${ROOT}/.staging-${short}.$$"
  rm -rf -- "$staging"
  mkdir -p -- "$staging"
  trap 'rm -rf -- "$staging"' EXIT
  git -C "$REPO" show "${resolved}:${ARTIFACT}" > "${staging}/$(basename "$ARTIFACT")"
  landed=$(shasum -a 256 "${staging}/$(basename "$ARTIFACT")" | cut -d' ' -f1)
  # 这一步是整个脚本存在的理由：不验证的话，"发布了哪个 commit"仍然只是口头声明。
  [ "$landed" = "$expected" ] \
    || fail "落地指纹 ${landed:0:16}… ≠ 应有 ${expected:0:16}…；未切换 current"
  {
    printf 'commit=%s\n' "$resolved"
    printf 'artifact=%s\n' "$ARTIFACT"
    printf 'sha256=%s\n' "$expected"
    printf 'built_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'released_by=%s\n' "${CLAUDE_CODE_SESSION_ID:-unknown-session}"
  } > "${staging}/PROVENANCE"
  mkdir -p -- "${ROOT}/releases"
  mv -- "$staging" "$target"
  trap - EXIT
  say "  ✅ 已写入 ${target}"
fi

# 原子切换：先建临时软链再 rename，避免出现「current 短暂不存在」的窗口。
#
# ⚠️ 必须带 -h。`current` 已存在且指向目录时，不带 -h 的 mv 会**跟随软链**，
# 把临时链接移进那个目录里，而 current 纹丝不动 —— 第一次发布看不出来
# （current 还不存在），第二次起静默失效。2026-09-21 沙箱实测撞到，
# 是被下面那道「切换后重算」的校验抓住的；没有那道校验就会带着旧版本上线。
link_tmp="${ROOT}/.current.$$"
ln -sfn -- "$target" "$link_tmp"
mv -fh -- "$link_tmp" "${ROOT}/current"
say "  ✅ current -> releases/${short}"

now=$(shasum -a 256 "${ROOT}/current/$(basename "$ARTIFACT")" | cut -d' ' -f1)
[ "$now" = "$expected" ] || fail "切换后 current 的内容对不上；请立即人工核查"
say "✅ 发布完成：${short}（current 指纹 ${now:0:16}…）"

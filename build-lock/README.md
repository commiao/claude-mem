# 可复现构建的依赖锁（T-0322）

本 fork 发布时，mac-release 用 `git archive` 打包，`plugin/` 下提交进仓库的 bundle
（`plugin/scripts/*.cjs` 等）就是线上实际运行的代码。改了 `src/` 之后，必须用**同一套依赖**
重建这些 bundle 再提交，否则发出去的仍是旧逻辑。

根目录的 `package-lock.json` 被 `.gitignore` 忽略：上游和 CI 都按 `package.json` 现解析依赖，
所以直接 `npm install` 会随 npm 新发布的版本漂移（2026-10-19 实测：新版 posthog-node 需要
`@opentelemetry/api`，主干因此构建失败）。这里单独保存一份锁文件，只供构建 bundle 使用，
不影响 CI 和上游合并。

## 用法

```bash
scripts/build-reproducible.sh            # 按锁文件 npm ci，再 npm run build
scripts/build-reproducible.sh --verify   # 同上，并检查提交的 bundle 与重建结果逐字节一致
```

脚本临时把锁文件复制到根目录执行 `npm ci`，结束后删除，不改动其他构建步骤。

## 这份锁文件从哪来，怎么证明对得上

- 2026-10-06 构建并提交的 bundle（7c2a3059d）内嵌了依赖版本：
  `CLAUDE_AGENT_SDK_VERSION="0.3.276"`、posthog-node `"5.52.4"`。
  前者发布于 2026-09-18T01:40Z，后者的下一个版本 5.53.0 发布于 09-23，
  再下一个 agent-sdk 版本 0.3.277 发布于 09-18T16:22Z。所以当时的依赖解析落在
  2026-09-18 01:40–16:22（UTC）之间。
- 用 `npm install --before=2026-09-18T16:00:00Z` 在 7c2a3059d 上解析出本锁文件，
  再按锁文件 `npm ci && npm run build`：`plugin/` 下全部 `*.cjs` / `*.js` 与 7c2a3059d
  提交的产物**逐字节一致**。
- `*.map` 不一致，只差在记录的 node_modules 相对路径（原构建机的依赖目录位置不同），
  映射内容相同，所以 `--verify` 不比对 map。

构建环境：node v22.15.0、npm 10.9.2、bun 1.3.13（macOS arm64）。

## 什么时候更新锁文件

升级依赖属于有意的变更：在独立分支用新依赖重建，逐个说明 bundle 的差异来源，
连同新的锁文件一起走 PR。不要为了"能构建"随手 `npm install` 后直接提交 bundle。

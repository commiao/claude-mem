# T-0065：T-0064 已核实缺陷修复

> 2026-09-09 后续复核已完成：SDK 固定为 0.3.261、6 项类型错误已修复、请求预算增加 JSON 转义和 UTF-8 字节校验。最新结果见文末“后续提交复核”；下方最初验证和上线缺口保留为历史记录，以文末更新为准。

交付状态：可审查源码补丁与离线验证完成，**未部署，尚不满足直接上线条件**。保留主观察提炼和 Graphiti，没有采用已撤回的预压缩开关。

## 基线与范围

- 基线：`231e046fbcbdb9f28c24ae1076c39693369a4689`，本地最新提交，包含来源回放身份修复。
- 隔离目录：`/Users/mac/workspace_codex/t0064-quality-fix`，分支 `fix/t0064-quality`。
- 原目录的 `.test-state/`、`T-0021-investigation.md`、`artifacts/` 原有未提交内容未纳入补丁；没有修改 credvault 或运行包。
- 读取 REPORT.md 末尾两次复核、两组验证脚本和 JSON，并用原固定样本回放。未发现此源码树内的 AGENTS.md。kg-hub 工具未暴露；文档所示本地 8080 canonical_context 不可达，未因此阻塞修复。
- 严格接纳与持久化暂缓接入实际使用的 **ClaudeProvider**。共享序列化修复也适用于其他调用者；其他 provider 保留原有非严格回退，不能宣称所有 provider 的静默截断已消除。

## 补丁行为

1. 只在工具结果边界一次解析符合 `stdout:string / stderr:string / exit_code:integer|null` 的 JSON 字符串。保留额外键值和嵌套字符串；不递归解码，不解析工具输入或任意 JSON 文本。
2. 压缩结果先加 condensed 包装，再以最终提示词相同的 JSON 序列化形式核算 16000 字符限制。Claude 最终构造提示词时再次严格校验；超限、空结果、失败和超时都抛显式准备失败，不进入头尾截断。
3. 观察和总结发送前核算 `history + incoming`。观察在一个空的新 generation 中仍不满足操作字符预算时直接暂缓，避免重复 recycle。400000 和 16000 仅是操作限制，不代表模型上下文容量；没有放宽常量。增加 SDK 返回容量元数据日志，供核对网关契约，未将别名的 SDK 默认容量直接用于安全容量推导。
4. 字段 query 拥有独立 AbortController 和进程所有者。30 秒到期只取消该字段请求；close SDK、清理迭代器并确认自己的子进程 exit。SIGTERM 后最多 1 秒再 SIGKILL，进程确认窗口 2 秒；上层取消清理最多额外等 5 秒，无法确认即明确失败。只接纳 SDK 成功终态，拒绝部分回答和错误结果，不增加重试。
5. 失败先保存完整原消息到 `deferred_observations`，再只移除该条 RAM claim；不写成功或 skipped receipt，不中止正常主观察。后台来源恢复排除暂缓身份，重复直接入队返回 409。未注册来源的旧消息也保存原始 payload，避免仅靠源指针恢复。
6. 显式恢复保留原身份，重复触发不重复入队；暂缓记录直到成功/有意 skipped receipt 与输出事务提交后才删除。数据库重开后仍可恢复；存储事务失败保留暂缓记录。

## 恢复入口

补丁部署后，先查看 `GET /api/observations/deferred`（最多最早 100 条，返回身份/原因，不返回原始内容）。修正记录的原因并完成内容审查后，向 `POST /api/observations/deferred/retry` 提交：

```json
{"sessionDbId":123,"contentSessionId":"原会话ID","toolUseId":"原工具ID","reviewedReason":"已修复的原因与审查依据"}
```

入口检查数据库会话身份后执行一次恢复，启动仍服从既有 provider/配额门控。`queued` 不是完成；以 `observation_receipts` 与实际观察内容验收。恢复后再次失败会继续保留暂缓记录，不后台自动重试。恢复不是降低质量标准的授权，原始超长内容不能直接截断后提交。

## 验证

- 相关 7 文件 **112 pass / 0 fail**，包括 20 项新增针对性测试：最终转义超预算、两条约束保留、失败不重试、取消/完成竞态、部分结果拒绝、双字段终态、主生成器继续处理、预算触发 recycle 身份不确认、持久化重开恢复、重复恢复去重、事务失败、恢复 HTTP 会话身份检查。
- 使用本地实际安装的 Agent SDK **0.3.263**，通过它的自定义 spawn API 运行一个无网络的真实本地子进程，验证取消后 exit 已确认。另用忽略 SIGTERM 的子进程验证 SIGKILL 回收。该测试不调用任何模型。仅调用 SDK close/return 的初版测试不能证明进程已退出，因此最终实现增加独立进程所有者。
- 固定 356 份历史数据：136 份符合已知结构，19 份规范化后免压缩候选。旧 5 份二次截断反例现在 **4 份显式暂缓、1 份规范化后完整接纳**。对长度不超过 16000 的 38 份历史答复接纳回放为 34 接纳、4 暂缓，没有新增头尾截断。
- `4f3c2381` 真实历史样本：原文、历史摘要和本次最终提示词均含两条发布约束。只验证这两条具体证据，不证明整份摘要语义完全正确。
- 历史回放没有新模型调用；不是 5 次线上事件，也没有线上节省声明。
- `tsc --noEmit` 仍有 6 项基线错误：安装 CLI 的 5 项 symbol 联合类型错误及 ResponseProcessor:449 的 nullable session ID。对照同依赖的原基线为 7 项；本补丁顺带纠正 SourceRecovery ingest status 类型不匹配，未新增错误。**不宣称全仓类型检查通过**。
- `git diff --check`、spawn 环境隔离检查通过；ESM esbuild 编译 smoke 通过。生成的 `artifacts/worker-review.mjs` 外置依赖，只用于审查，不是可部署运行包。
- 证据：`artifacts/tests.txt`、`artifacts/historical-replay.json`、`artifacts/typecheck.txt`、`artifacts/typecheck-baseline.txt`、`artifacts/build.txt`。

SDK API 依据：[官方 TypeScript SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript)；本机 sdk.d.ts 同时说明 close、modelUsage.contextWindow/maxOutputTokens 和自定义 spawn 的延后取消信号。SDK 元数据不替代实际网关模型契约。

## 上线前必须满足

1. **真实模型容量仍未核实**：现场配置为 `claude_mem.observation`，经过 `http://127.0.0.1:39001`；本地没有可用的已发布 route 配置。必须核实实际 route revision、后端模型、上下文和输出上限、SDK 元数据是否匹配，并据完整请求做 token 预算验收。当前补丁只修复已有操作字符预算漏算 incoming，不提供未知模型的容量保证。
2. **运行包有差异，不能直接覆盖**：实际 worker 为 `/Users/mac/.claude/plugins/cache/thedotmack/claude-mem/13.24.1/scripts/worker-service.cjs`。本次读取 SHA256：`8ecaa147ff31bb11f3a71b8d277bee0c08139c9a1a2ea6ef4ab15ae8636fed47`；源码树已有 bundle 为 `f301b7bdb6f9ff6f3571ad21a303625000fdd592ad29c863fc5e93d4cc588118`。未逐项证明运行热补丁等价。部署必须先备份运行文件、配置和 SQLite，记录哈希、可恢复路径，并将已存在的采集/来源恢复/槽位补丁映射回构建源码。
3. **SDK 一致性**：源码声明范围 `^0.3.172`，本轮解析到 0.3.263；部署构建必须固定依赖并在对应 SDK 上重跑真实子进程回收测试。不得假定运行 bundle 内嵌 SDK 与本轮相同。
4. **质量灰度**：对受控长输入逐条核对中间约束、否定条件、错误信息、来源身份、成功 receipt 和暂缓记录；观察恢复后是否不丢不重。允许暂缓增加，不能用请求数或队列下降替代验收。没有实施分块全覆盖提炼或自动重试。
5. **回退保护**：旧代码不认识暂缓表，回退后自动来源回放可能重试这些身份；回退必须保留 DB 和暂缓数据、先暂停来源恢复，再恢复备份运行包。不能直接删除暂缓行或清空队列。

没有重启 worker/容器、提高网关限额、启用 503 重试、发外部消息或修改父任务飞书文档。父任务主观察模型必要性的讨论不在本补丁内。

## 后续提交复核（2026-09-09）

核查结论：`cbdebe3` 后遗留的全部源码、测试和两个验证脚本都属于 T-0065 的预部署核验，不是其他任务混入。本次将这些内容纳入一个独立后续提交。没有 reset、checkout 或删除原有文件；未覆盖安装目录、重启服务、变更网关或调用真实模型。

### 纳入理由与审查结论

- `package.json`：把 SDK 范围固定为运行 bundle 中核实的 **0.3.261**。现有根 `node_modules` 是其他源码树的链接，未改写；验证和候选构建显式使用 `artifacts/predeploy/sdk-0.3.261/` 中的隔离安装。仓库根锁文件原本被忽略；此改动只固定 SDK，不宣称所有传递依赖已完整锁定。
- `install.ts`：三个交互提示返回值中的 symbol 表示取消，按 `typeof === 'symbol'` 排除后保留正常选择的类型收窄，消除原有五项类型错误。
- `ResponseProcessor.ts`：在已有空值检查之后捕获会话 ID，再交给事务回调，消除剩余一项 nullable 类型错误，不改变 receipt 事务边界。
- `observer-request-budget.ts` 与 `ClaudeProvider.ts`：网关限制按序列化 messages 计数，原始字符串长度会漏算反斜杠等转义；多字节文字还可能先触达 1 MiB 请求限制。观察、总结以及独立字段压缩的预检计入 JSON 序列化和 UTF-8 字节；保留现有字符上限，额外预留 16 KiB 加每条消息 256 字节的 SDK 封装空间。超大字段压缩请求在 SDK 启动前以 `compression-input-over-budget` 暂缓。该预留是固定版本下的操作预算，**不是精确 token 计数或所有请求形态的上界证明**。
- 测试：允许显式选择核实过的 SDK；扩大 history fixture 以保持原测试确实走 recycle 而不是单条暂缓；新增转义超限、UTF-8 超限、history 封装预算及压缩前置拒绝四项测试。
- `scripts/audit-t0065-runtime.ts`：读取既有安装包、发布包和备份 manifest，输出本地比对报告；`scripts/build-t0065-candidate.mjs`：只构建隔离候选文件，显式选择 SDK 0.3.261 并记录输入哈希。二者是本机 T-0065 验证工具，路径依赖本次工作区，不是通用部署命令。

### 已核实与仍待验证的部署条件

- 14:22 的只读网关证据确定 `claude_mem.observation` 路由为 `qwen3.8-flash`，thinking disabled，最大输出 8192；配置中的输入限制为 400000 字符、请求体 1048576 字节。routes 文件 SHA256 为 `55db0e9028010352aec84591fedfb7d9bab28c5111a26f9cf44a5137ce046346`。SDK 别名返回的 200000 context / 32000 output 不代表后端真实容量。[模型官方容量文档](https://help.aliyun.com/en/model-studio/qwen3-8-flash)与网关操作限制需要分别理解。
- 同次健康检查报告 `idempotency_outcome_unresolved` 和 `provider_state_write_failed`，`effective_limits` 为空；不能宣称网关健康或已完成线上有效限额验收。本轮未清理这些状态。
- 已核实运行 SDK **0.3.261**、配置使用的 Claude CLI **2.1.126**。此前本地假 API 捕获这两者的实际请求，ASCII、反斜杠和中文三组输入都落在新增封装预留内；没有发送到真实模型。SDK 包自带的可选 CLI 与实际配置的 CLI 版本不同，因此证据以 `capture-live-cli-*` 为准。
- 安装包仍为 `8ecaa147ff31bb11f3a71b8d277bee0c08139c9a1a2ea6ef4ab15ae8636fed47`，与记录的最终发布包一致。本次重新运行审计：原 7007 个顶层声明有 6998 个不变、9 个变更，另有 3 个恢复辅助声明；7 组备份 manifest 哈希均匹配。变更映射为 FIFO 槽位、Claude/Codex 原生工具 ID、dispatch 身份、来源指针 hook、SessionManager 去重、ResponseProcessor 原子 receipt、WorkerService 启停恢复；相关路径包含在下面的回归中。该结构比对加回归并非任意生产流量上的完全等价证明。
- 质量灰度、精确 token 容量验收及回退保护仍然适用。当前交付是可审查代码与隔离候选包，**未部署**。

### 本次复跑

类型检查均返回 0：

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p src/ui/viewer
./node_modules/.bin/tsc --noEmit -p artifacts/predeploy/tsconfig-sdk-0261.json
```

第三条将 SDK 类型显式映射到隔离的 0.3.261 声明。回归使用该版本 SDK，并将测试子进程的 HOME 指向新建临时目录，避免写入真实 Cursor 数据；命令如下（完整命令与临时目录记录在 `artifacts/predeploy/review-test-command.txt`）：

```sh
T0065_SDK_ENTRY="$PWD/artifacts/predeploy/sdk-0.3.261/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" bun test \
  tests/install-non-tty.test.ts tests/install-disable-auto-memory.test.ts \
  tests/transcripts/processor-codex-context.test.ts tests/transcripts/watcher-start-at-end.test.ts \
  tests/transcripts/match-rule-negation.test.ts tests/transcripts/cli-dispatch.test.ts \
  tests/transcripts/observed-model-extraction.test.ts tests/transcripts/cursor-extraction.test.ts \
  tests/transcripts/config.test.ts tests/transcripts/grok-bot-config.test.ts \
  tests/shared/observer-recycle.test.ts tests/shared/observer-request-budget.test.ts \
  tests/sdk/prompts.test.ts tests/worker/field-optimizer.test.ts \
  tests/worker/provider-classifiers.test.ts tests/worker/t0064-quality.test.ts \
  tests/worker/overflow-recycle-resume.test.ts tests/worker/session-manager-null-prompt.test.ts \
  tests/worker/session-manager-project.test.ts tests/supervisor \
  tests/cli/adapters/claude-code-subagent.test.ts tests/cli/adapters/codex-file-context.test.ts \
  tests/worker/agents/response-processor.test.ts tests/services/worker/session-message-buffer.test.ts
```

结果：**362 pass / 0 fail，29 文件，929 断言**。首次沙箱执行的 6 项失败来自 Cursor 测试目录写权限、进程身份读取及本地端口监听限制；允许测试所需权限并隔离 HOME 后全部通过。此处的 6 项测试环境失败与已修复的 6 项 TypeScript 基线错误是两回事。

以下也全部成功：

```sh
node scripts/check-spawn-env-discipline.cjs
bun scripts/audit-t0065-runtime.ts
node scripts/build-t0065-candidate.mjs
node --check artifacts/predeploy/candidate/scripts/worker-service.cjs
git diff --check
```

历史 356 样本回放证据仍在：136 份规范化、19 份免压缩候选，旧 5 份二次截断反例为 4 暂缓 / 1 完整接纳；本次仅新增压缩输入预检测试，没有把历史回放说成新的线上调用。

`artifacts/` 保留为未跟踪证据，包括先前补丁、历史回放、只读现场快照、假 API 捕获、SDK 隔离安装和构建产物。本次不将整个目录提交：其中含临时依赖、二进制和本机数据，源码审查不需要这些进入版本库。没有删除或覆盖原有报告日志；复跑结果使用 `review-*` 文件，构建和审计工具的固定输出路径会更新本地衍生产物。核心结果已写入本报告，原始输出可在本机复查。

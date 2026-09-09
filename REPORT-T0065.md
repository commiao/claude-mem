# T-0065：T-0064 已核实缺陷修复

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

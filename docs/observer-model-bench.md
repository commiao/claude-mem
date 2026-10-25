# claude-mem 抽取与压缩模型对比

对同一份原始工具记录或摘要输入，用 Claude Code、Codex、Cursor 等工具内的模型，批量比较抽取效果、提示词和分批策略。结果单独保存在评测目录，不写入记忆库或 kg-hub。

入口：在 claude-mem 的源码检出中运行 `python3 scripts/observer_bench.py --help`。需要 Python 3.10+ 和 Bun；不需要启动 worker。本版是独立离线工具，不修改已安装 worker 的运行配置。

## 评测的单位

- **case** 是一段固定来源记录或一次摘要输入，含多条工具记录时仍是同一个案例。
- **request** 是实际发给工具的一包提示词。`--batch-items 1` 与 `20` 会产生不同请求数，但按同一个 case 汇总事实，才能公平比较分批策略。
- **run** 固定工具、模型、提示词变体、批大小、重复次数、案例选择；每条请求有内容指纹。
- **bench** 冻结案例、标签、实际业务提示词及源码指纹。提示词使用 `src/sdk/prompts.ts`，解析使用 `src/sdk/parser.ts`；当前支持仓库内置 `code` mode。未调用 `ResponseProcessor` 落库流程，不把解析通过冒充线上完整成功。

跨天重跑使用冻结后的提示词，避免提示词内的日期变化。代码变化后需要重新冻结；已经写入的样本与结果不覆盖。

## 1. 准备固定样本

仓库提供六个人工构造的示例，覆盖修复、噪声跳过、计划与完成状态、日志内恶意指令、摘要、重复事实。它们用于操作演示和回归，不能代表真实业务模型排名。

```bash
python3 scripts/observer_bench.py freeze \
  --cases docs/examples/observer-bench-cases.json --out /tmp/cm-bench/example
```

真实样本从本地 worker 数据库**只读**抽取：

```bash
python3 scripts/observer_bench.py sample \
  --db /path/to/claude-mem.db --limit 30 --seed 20261025 --format records \
  --out /path/to/private-eval/raw-cases.json
python3 scripts/observer_bench.py freeze \
  --cases /path/to/private-eval/raw-cases.json --out /path/to/private-eval/frozen
```

抽样只看有上限的最近插入批次池，轮流覆盖任务种类、历史状态和项目，并非全库随机总体估计。不把过去的模型答案当正确标签。

`--format records` 在同一个只读快照中取回原始 observation 记录，支持重组不同批大小，并记录原请求指纹；摘要保留原请求，避免错误地加入未来新产生的 observation。默认的 `--format requests` 则保留完整历史原请求，适合逐字重放比较模型与提示词，observation 不支持重新分批。

真实记录可能包含私有内容，放在仓库之外的本人目录。评测文件使用私有权限。`sample`、`freeze`、`prepare`、`import`、`score` 均不调用 LLM。

### 给样本加标签

原始案例格式见 `docs/examples/observer-bench-cases.json`。建议按会话/项目预先划分 `dev` 和 `holdout`，调整提示词只看 dev，最终再看 holdout。工具不会把标签发给被测模型。

```json
{
  "id": "case-001",
  "kind": "observation",
  "split": "dev",
  "project": "example",
  "user_prompt": "修复后记录依据",
  "records": [{
    "tool_name": "Bash",
    "tool_input": {"command": "run-tests"},
    "tool_output": "12 tests passed. Not deployed."
  }],
  "expected": {
    "action": "keep",
    "required_facts": [{"statement": "12项测试通过", "anchors": ["12"]}],
    "forbidden_claims": [{"statement": "不能把未发布说成已发布", "anchors": ["deployed to production"]}]
  }
}
```

`anchors` 是词面诊断；命中并不能证明理解正确或没有幻觉。比如“没有上线生产”也可能含“上线生产”的字样，必须结合盲评判断。

摘要使用 `kind: "summary"`，提供 `last_assistant_message` 和 `persisted_observations`，后者最多20条、12000字节，与当前队列的有界补充上下文一致。它与 observation 分开评分，避免两个业务阶段混淆。

## 2. 在工具会话里领批和交卷

每个候选分别准备一个 run，模型名称填写工具界面实际选择的标识：

```bash
python3 scripts/observer_bench.py prepare --bench /tmp/cm-bench/example \
  --out /tmp/cm-bench/tool-a --executor cursor --model MODEL_A --label tool-a \
  --batch-items 20 --repeat 2
python3 scripts/observer_bench.py prepare --bench /tmp/cm-bench/example \
  --out /tmp/cm-bench/tool-b --executor codex --model MODEL_B --label tool-b \
  --batch-items 20 --repeat 2
```

把 run 目录中的 `INSTRUCTIONS.md` 和 `packets/` 给对应工具。每包新会话，仅处理所给提示词，不读标签、另一候选答案或记忆上下文。关掉自定义工具和钩子以减少污染。工具无法禁用宿主系统提示时，应把它视为“工具 + 模型”的组合测试，而非裸模型精确复现。

根据 `results-template.json` 生成新的结果文件：复制 `id` 与 `request_sha256`，把原始 XML 放入 `text`，不用模型自述填充 token、费用或模型身份。界面/调用记录看不到的字段保留 `null`。模型身份来自人工填写时只是声明；工具/供应商元数据才能提供较强依据，均不是供应商签名证明。

```bash
python3 scripts/observer_bench.py import --run /tmp/cm-bench/tool-a --results /tmp/cm-bench/tool-a/results.json
```

重复导入完全相同的结果是幂等的；不同内容覆盖已有结果、错误指纹、重复请求编号均会拒绝。为比较新提示词，创建新 run，不修改旧卷。

## 3. 自动批量运行原生 CLI

自动通道复用 kg-hub **现有的通用工具执行器**（claude、codex、qodercli），不复制另一套登录、代理、隔离或模型调用代码。通过 `--runtime-repo` 显式指定提供该执行器的 kg-hub 检出；手工领批和离线评分不依赖它。今后通用执行器迁入独立包时，只需替换这个适配层。

```bash
python3 scripts/observer_bench.py run --run /tmp/cm-bench/tool-b
python3 scripts/observer_bench.py run --run /tmp/cm-bench/tool-b \
  --runtime-repo /path/to/kg-hub --execute --effort medium --timeout 900
```

第一条只预览请求数。带 `--execute` 才使用工具的现有登录调用模型；先发一个不含样本的最小探针，再逐包执行。探针的返回与消耗单独留存。执行器版本和推理强度绑定到运行记录。

每包新会话，串行运行；本版没有另建模型网关或通用并发调度器。超时、认证失败、模型身份不匹配等停止本次执行，不自动重试。发送前已有持久化 attempt 但没有结果时，重启也会拒绝自动重放，需要人工核实。评测并不消耗或改变业务 worker 队列状态。

`request.max_tokens` 保留业务请求的元数据，但原生工具不一定提供对应参数，工具实际输出预算标记为未保证执行。Native CLI 与线上网关的系统提示、限流、模型路由和计费可能不同；候选通过离线评测后，仍需线上小流量验证，不能用 CLI 的耗时直接宣称线上吞吐。

## 4. 比较提示词和批大小

```bash
python3 scripts/observer_bench.py prepare --bench /tmp/cm-bench/example \
  --out /tmp/cm-bench/concise --executor cursor --model MODEL_A --label concise \
  --batch-items 5 --repeat 2 --prompt-append /path/to/concise-instruction.txt
```

追加提示词内容和批大小会写入运行指纹；评分要求案例集、选择范围和重复次数相同。分批后的输出聚合回原 case，记录实际请求次数和重复事实。不得只对表现差的案例偷偷修改输入后仍作为同一轮比较。

## 5. 质量盲评与对比报告

先用业务解析器筛查，再做事实核验。盲评表隐藏候选名称和模型标签，按原来源对照回答；可交由人工或另一工具评审。

```bash
python3 scripts/observer_bench.py review --runs /tmp/cm-bench/tool-a /tmp/cm-bench/tool-b \
  --out /tmp/cm-bench/blind
```

只把 `review.json` 给评审者，保留 `key.private.json`。填写 reviewer、四项0–4分和来源/输出证据：事实忠实性、关键事实覆盖、噪声控制、未来会话可用性。不要按字数或文笔判断。评审表绑定原来源和原输出，结果变化后旧评分失效。

```bash
python3 scripts/observer_bench.py score --runs /tmp/cm-bench/tool-a /tmp/cm-bench/tool-b \
  --out /tmp/cm-bench/report \
  --review /tmp/cm-bench/blind/review.json --review-key /tmp/cm-bench/blind/key.private.json
```

输出 `report.html`、`report.json`、`comparison.csv`。HTML 可展开每个案例，对照来源、分包原始回答及具体错误；包含真实记录的报告也须保存在私有目录。未完成盲评也能出机械指标报告，但语义效果显示“未评”。不自动用一次总分挑模型或修改生产路由。

| 维度 | 统计与限制 |
|---|---|
| 业务可用性 | 完整案例的解析通过率、缺卷、输出截断、保留/跳过正确率；缺失结果计入分母 |
| 内容诊断 | 标签锚点覆盖、禁用锚点命中、重复 facts；它们均不是语义真值 |
| 压缩 | 输出知识文字与来源文字的字符保留比，不能写成 token 压缩率；不同方案不得只比越短越好 |
| 语义效果 | 盲评四项分数和覆盖的案例数；无评审为未知，部分评审不能充当全量结论 |
| 效率 | 每个案例的请求数、请求调用耗时p50/p90与观测覆盖率；不推断并行墙钟耗时 |
| token | 看不到的数值未知；部分可见只报告已知部分和覆盖率，不补零 |
| 成本 | 按 USD/CNY/积分等单位、measured/declared/estimated来源分别汇总；不混加，不把订阅费用按token伪装为实际支出 |

先确认忠实性、事实覆盖和解析率达标，再比较单位案例的请求数、延迟和费用。为验证稳定性，建议同样本重复运行，并使用预先保留的 holdout 案例。

## 验证本工具

```bash
python3 -m unittest discover -s tests/evaluation -p 'test_*.py' -v
```

测试使用真实业务提示词和解析器，加合成回复与模拟的原生执行器，不会调用付费模型。原生工具的真实模型可用性只有执行当次的探针才能确认。

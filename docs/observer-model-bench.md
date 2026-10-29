# claude-mem 观测与摘要评测

公共执行、证据、评审、准入和报告已迁至私有 llm-eval 包；本项目只维护业务适配、只读样本导出和真实业务 bridge。
原 scripts/observer_bench.py 是公共CLI的薄入口，不再支持 --runtime-repo 或导入 KG checkout。
需要 Python 3.11+、Bun，以及同一发布组合安装的 llm-eval / claude-mem-eval wheel。

## 记忆质检（MemCheck）

本工作流的固定名称是**记忆质检（MemCheck）**，覆盖观测抽取、摘要压缩、事实保真、
噪音过滤和新增产出。独立`mem-check`技能随发布源码提供；经 sidecar 安装并验证 Codex
发现后，可用 `$mem-check` 或“运行 MemCheck 记忆质检”唤起。安装状态以实际发现结果为准。

快速检查候选源码，无模型调用：

```text
python scripts/mem_check.py status
python scripts/mem_check.py quick --out /private/eval/mem-check-new-run
python scripts/mem_check.py quick --evidence /private/eval/existing-audit --out /private/eval/mem-check-replay
```

候选源码的过滤及实际入库回归（仅用户明确要求验证该候选时运行）：

```sh
python scripts/mem_check.py persistence \
  --evidence /private/eval/frozen-real-audit \
  --annotations /private/eval/frozen-real-audit/review-annotations.json \
  --out /private/eval/new-persistence-replay
```

该入口锁定当前已发布基线源码，复用原请求、原回复及已绑定来源/输出的价值标签，
分别通过基线与候选的生产解析器和 `SessionStore` 写入两个全新的临时 SQLite，随后只读回查。
它复用已安装适配器的标签/历史回执校验及过滤指标汇总器，不读取或写入真实记忆库，
不重新生成回复、不调用探针或 judge。原始生成数保持不变，入库拦截不能冒充模型主动跳过。
报告并列历史实际、空库基线回放和空库候选回放；空库回放没有完整历史去重状态，
历史与回放的差异不得计入修复收益。只有缺失标题可复制已有副标题，原事实和正文必须一致。

候选的 `ObservationQualityGate` 被队列入库、直接响应入库和评测 bridge 共用。
它只识别纯计划工具、完整的只读文件清单命令及特定旧版 `episode_body` 转储格式；
混合来源、诊断错误、不认识的命令和新分析保持可入库。历史转储规则是保守的格式识别，
不是通用语义去重：不支持的历史阅读方式仍可能漏过，复杂脚本内混合的新旧证据需要人工核对。
缺标题且没有可复用副标题的内容仍拒绝。输出索引与拒绝理由随任务回执保留，不能把空新增统一算去噪成功。
这不修正原回复中的事实错误，也不签发生产准入；安装中的评测 wheel 和生产 worker 不随源码编辑自动改变。

### 来源过滤前移与决策模型分诊

队列先把完整原事件存入 `observer_tasks`，随后在 `prepareBatch` 创建付费任务之前，
对同一批来源调用共用过滤器。统一的非持久来源批次记录 `phase=before_model`、
策略版本、理由和 `externalCalls=0` 后进入 skipped；原事件不删除。混合/未知来源保持放行。
直接 SDK 路径只对已有 durable task 的来源做前置过滤，保留旧输入的入库后防线。
摘要不会被观测来源过滤器拦截；已经提交的付费任务不追溯改写。
`observer_prefilter_replay.ts` 只在临时 SQLite 回放队列准备，不提交模型任务。
历史输入/输出 token 的可避免量是反事实测算，不是已部署节省或货币账单。

`claude_mem.observation_triage` 是独立的诊断场景，模型路由为已有的 `kg_hub.obs_triage`。
一个冻结观测加原始来源组成一个样本，原有价值标签不进入请求；只询问价值、新增性和来源支持，
不重写观测。来源过长时显式保留首尾并标记截断，不能把未展示的来源当作支持证据。
value=low/none 且 confidence≥0.9 仅记录“会拒绝”的诊断指标；该阈值未校准，不能自动启用生产拒绝。
原 KG 长度/分数闸不能直接成为该场景的价值标准。沿用的标签并非独立真值，事实支持未知不作负例。

公共核心暂没有 SystemOne 原生执行器。本场景通过已安装业务包中的 `triage_transport` 显式读取
共享计划，使用既有专用 caller 提交并以公共 `import_results` 导入；证据等级保持 manual-declared，
不冒充 native-local-observed。原始请求/HTTP 回复、调用前 fsync 的日志、用量声明及停止原因单独封存。
外部传输授权文件绑定 plan hash 和 33 次上限，抽取/探针/自动重试为0；串行控制在30 RPM以内。
发送前整批检查网关的两种限制：`messages` 紧凑 JSON 的字符数（包括嵌套转义）及请求体 UTF-8 字节数；
不能只按模型 query 的字符数估算。任一包超限都在读取凭据和网络调用前拒绝整批，保留原冻结输入。
HTTP失败或未知结果停止整轮，不继续耗用剩余预算，已有尝试禁止自动重放，也不换用其他 caller。
计费未知保留未知，0输出token不代表0输入token或已核实0费用。

候选 wheel 可安装到独立的评测组合，在 `--bundle` 中锁定；不激活全局指针或修改生产路由。
模型评测沿用公共 freeze/plan/prepare/import/score/review/report，完整性和身份门仍由公共核心执行。

#### 原子分诊 v2

新增 `claude_mem.observation_triage_v2`，旧场景及旧冻结试验继续使用原 wheel。
v2 用 Noul 单独判断长期价值，用 Choice 分别判断相对已展示旧记忆的增量和来源支持；
三个答案在代码中组合 `keep / review / drop`。Noul 是 P(yes)，不当作 Choice confidence；
默认0.9仍是未校准的起始策略。来源冲突、关键证据省略、重复对照不足都进入 review，
review 不表示通过，也不按丢弃计数。即使判定重复，也必须有可靠历史正文及完整候选正文证据。

使用安装版本所对应源码中的 `scripts/observer_triage_prepare.py`，显式提供旧观测、原始来源、
原入库回执和只读数据库。它在 read-only/query-only 事务中按项目和原事件时间取对照，
排除整个评测批次的已知 observationIds（含合并目标），避免拿待评输出判自己重复。
先查精确正文候选（不是只比标题），再从最近至多500条中做确定性词项相关检索，最多带3条。
这不是向量语义检索，不声称覆盖全库；没有候选不证明新增。当前库里旧行的正文可能已变，
所以导出器一律标历史正文未验证；仅真正早于事件的不可变快照才能声明时间验证，不能事后补勾。
精确匹配可在本地处理：可靠历史匹配为 drop；历史未验证为 review，均不调用模型。

来源保留为结构化记录和相关原文片段，不再把所有来源编码为一个长字符串。
起止位置和哈希放在请求附带的本地 evidence_receipt，模型只看同一批原文片段与省略标记，减少格式开销。
来源默认6000字符、旧记忆2400字符；必要时缩小来源片段预算，保留观测正文及精确 JSON 长度检查。
超限且无法安全容纳时整批停止，不修改网关限额。字符/字节下降只证明请求体缩小，不冒充token或账单节省。

新场景必须重新 freeze/plan/prepare，旧三分类回复不能导入为 v2 的新模型结果。
传输须显式 `--scenario claude_mem.observation_triage_v2`，新授权文件必须绑定该场景及新 plan hash；
旧授权不能跨场景复用。确定性动作单独记录 local_decisions，不计 provider HTTP；
默认离线准备不生成授权文件、不调用模型、不激活全局组合或生产过滤。

`status`核实当前发布组合的两个mem场景、适配器来源与候选源码差异，并显示过滤指标是否由
共享适配器声明。`quick`运行摘要/存储边界与过滤计数回归、合成案例合同；有已有审计目录时，
另做同一历史回复的parser前后对照和已有价值标签重算。它不读真实DB、不重新生成回复，
接受结果的正文变化会使回放失败；新的拒绝项保存供审查。

**快速回归通过只证明代码与计数约束通过。** 提示词改动的实际收益需要固定同样本、允许上下文、
模型/profile，对旧版与新版重新生成并独立评审；同时比较事实支持、价值保留、无价值拦截、
低/无价值混入、新增条数和转化率，不能只证明调用成功或多产出。

## 与公共框架的版本边界

公共CLI通过已安装的`claude-mem-eval`适配器运行`claude_mem.observation`和
`claude_mem.summary`，适配器封装了由业务源码构建的bridge和mode资源，运行时不导入开发检出。
因此修改parser/prompt后，需要重新构建适配器并发布、验证和激活新的固定组合才影响新实验；
旧实验继续使用原计划绑定的组合。只改`current`、技能文字或源码都不会改写旧结果。

从 core / `claude-mem-eval` 0.1.2 起，过滤指标通过适配器 `summarize_score` 接入公共
`score/report`，HTML 与 `metrics.csv` 使用同一业务汇总；原脚本保留为薄入口。
语义价值标签通过 `--annotations FILE` 显式传入，绑定计划、来源与输出摘要；缺标签保留未知。
实际新增条数须另有只读持久化回读 receipt，新的离线生成不能冒充真实入库。
接口与证据格式见 `adapters/evaluation/FILTER-REVIEW.md`。只有发布并激活新组合后，
这些能力才影响新实验；快速入口分别显示候选验证与已安装框架状态。

## 数据与场景

使用 claude_mem.observation 或 claude_mem.summary，分开数据集/分数/策略。
示例 docs/examples/observer-bench-cases.json 为六个人工合成案例，按 kind 分开后冻结。
不代表任何真实模型成绩。真实样本包含私有记录，应留在仓库外。

只读导出：

```text
python scripts/observer_eval_sample.py --db /path/to/claude-mem.db --limit 30 --raw-records --out /private/eval/cases.json
```

导出使用只读事务、有限的最近批次池，按真实会话划分开发/保留集；历史回复不是gold。
raw-records 保存真实任务/会话/agent/prompt_number/context 信息以比较不同组批。
摘要保留当时已封存的原请求，不能追加今天的新 observations。
来源数据、语义标签和对比模型回复分开；未标注数据不签正式质量结论。

## 公共入口

```text
llm-eval freeze --scenario claude_mem.observation --cases observation-cases.json --scope development --out dataset.json
llm-eval plan --scenario claude_mem.observation --dataset dataset.json --candidates candidates.json --max-calls 0 --out plan.json
llm-eval prepare --plan plan.json --out run
llm-eval import --scenario claude_mem.observation --run run --results raw-tool-results.json
llm-eval score --scenario claude_mem.observation --run run --out score.json
llm-eval report --scenario claude_mem.observation --run run --out report
```

candidates.json 元素为 {id,executor,model}；手工Cursor/其他工具用 executor=manual，记录实际工具名。
每个packet新会话，屏蔽可关闭的记忆/工具/钩子，不读gold或其他候选输出，原样交回XML。
交卷每行复制 id/plan_sha256/request_sha256，text 填原始回复。人工费用/身份只算声明。
默认0调用预算；实际原生执行需先给模型、探针/补救总调用上限和已有授权。
实际探针与生成须按当轮确认的预算执行；离线验收不消耗模型调用。

profile 支持 maxItems（1..20）、maxBytes（4096..256000），max_tokens目前固定4096。
模型对比固定profile；链路对比才允许候选显式变体。工具没有强制输出预算的能力时明确未验证。
一个case可能多个请求，报告按原case聚合，不把5个小包和1个大包当同样数量的业务来源。

## 评审和验收

解析复用生产 parseAgentXml，之后做真实文件证据过滤和摘要归一化；不访问DB。
会话/context/prompt/agent、JS精确字节预算、摘要有界上下文由生产和评测的同一纯函数实现。
missing/认证/未知终态是执行状态；非法输出/截断是已观测到的质量缺陷。
anchors 是词面诊断，字符比不是token比，不能代替事实支持和计划/已完成状态的独立核验。

使用公共 review-create/check、admission、report；关键案例要求源引文与实际输出引文。
随机盲评与定向旧错分开计数。两个mem场景的正式门槛都未校准，最多离线通过，不切生产路由。

## 过滤质量与新增产出

新增条数、转化率、无价值内容拦截和混入均是正式指标。价值与事实正确性分开标注：
有技术价值的输入也可能被写错，内容真实也可能只是临时领取编号或无新增信息的轮询。
不能只用“产生了观测”或“XML可解析”判过滤合格，也不能以去噪为由省略新增产出。

独立来源核对完成后，可用本项目的纯业务汇总器聚合评审标签：

```text
python scripts/observer_filter_quality.py --labels /private/eval/filter-labels.json --out /private/eval/filter-metrics.json
```

它不调用模型、不读取生产数据库，也不代替公共CLI的冻结、执行、交卷、独立评审或准入。
标签文件采用以下结构；示例仅解释格式，不代表真实评测结果：

```json
{
  "schema_version": 1,
  "cases": [{
    "id": "source-case-1",
    "source_task_count": 1,
    "input_value": "valuable",
    "action": "generated",
    "outputs": [{
      "id": "source-case-1.observation-1",
      "value": "valuable",
      "fact_support": "supported",
      "persisted_ids": [101]
    }]
  }]
}
```

`input_value`/输出`value`为`valuable`（有持久价值）、`low`（低价值）、`none`（无价值）或`unknown`。
输出`fact_support`另填`supported`、`incorrect`或`unknown`。价值标签及引文证据在私有评审材料中保存，
汇总器不会猜测标签。`action`为`generated`、显式`skip`或无回复的`empty`；生成后未入库仍属`generated`。
`persisted_ids`只允许经任务结果和实际记忆行核实的**本次新增ID**，不能填合并到的已有ID、数组位置或布尔标记。
同批次outcome在多个来源任务中重复出现时，按真实ID去重；重复ID的标签有冲突时降为`unknown`。
一个新增ID必须只属于一个来源case；跨case重复归属会被拒绝，不能把同一新增记忆算进两个批次转化率。

分别报告：

| 指标 | 分母与口径 |
|---|---|
| 新增观测数 | 实际新增ID去重计数，与生成观测数分列 |
| 批次新增转化率 | 有实际新增观测的来源批次 / 全部来源批次 |
| 无价值输入拦截率 | 被显式跳过的无价值输入批次 / 已标注无价值输入批次 |
| 有价值输入误杀率 | 被跳过的有价值输入批次 / 已标注有价值输入批次 |
| 有价值输入未产出 | 无生成、无新增入库分别统计；不能因没有显式skip就认定已保留价值 |
| 无价值内容混入率 | 无价值输出条数 / 全部输出条数，生成端与新增入库端各算一次 |
| 低价值内容混入率 | 单列低价值；同时给低价值与无价值合计，不能隐去其中一类 |
| 事实错误混入 | 错误事实输出条数及比例，和价值维度分别呈现 |

没有语义证据的项目保留`unknown`，同时报告覆盖率和混入率上下界：
已确认数量/全部输出为下界，（已确认数量+未知数量）/全部输出为上界。
输入过滤率仅对已标注输入成立，必须同时展示输入标注覆盖率；零分母返回未知，不填零或100%。
这些范围不是总体置信区间。一个来源可拆成多条观测，新增数/来源数可以大于1，但不是事实保留概率。
未标定过滤门槛时不签生产合格结论；提示词收益必须另有同样本实际生成和独立评审证据。

适配包构建和业务边界见 adapters/evaluation/README.md；完整操作/新业务SDK见公共框架手册。
旧原型已生成的demo和真实未标注样本保持原目录只读，不重写旧指纹伪装成新格式。

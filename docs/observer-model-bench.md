# claude-mem 观测与摘要评测

公共执行、证据、评审、准入和报告已迁至私有 llm-eval 包；本项目只维护业务适配、只读样本导出和真实业务 bridge。
原 scripts/observer_bench.py 是公共CLI的薄入口，不再支持 --runtime-repo 或导入 KG checkout。
需要 Python 3.11+、Bun，以及同一发布组合安装的 llm-eval / claude-mem-eval wheel。

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
本轮仅离线验收，不发起真实探针。

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

适配包构建和业务边界见 adapters/evaluation/README.md；完整操作/新业务SDK见公共框架手册。
旧原型已生成的demo和真实未标注样本保持原目录只读，不重写旧指纹伪装成新格式。

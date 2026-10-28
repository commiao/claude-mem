---
name: mem-check
description: 记忆质检（MemCheck）：检查 claude-mem 抽取和摘要的事实保真、信息保留、噪音过滤、新增观测和转化率，或离线验证相关修改；不用于电脑内存诊断或通用模型排行。
---

把“记忆质检”作为 claude-mem 质量工作流的固定名字。实际执行仍使用已发布的 `llm-eval` 和 `claude-mem-eval` 适配器，不另造评测引擎。

本技能包只有操作指引。下文的脚本和文档是**业务发布目录中的外部运行时引用**，不在技能目录内，不相对当前项目工作目录执行。先用 `llm-eval scenarios` 核对两个 mem 场景的 `business_provenance.source_revision`；本机对应的源码发布目录是 `~/.local/share/claude-mem-eval/releases/<source_revision>`，需核对其中 `RELEASE.json` 的提交一致，记为 `memcheck_source`。使用活动评测组合的 Python 运行该目录里的脚本。目录或脚本不存在就报告当前版本未发布，不自动寻找开发树替代。

按用户目的选择：

- **抽查现有结果**：只读导出并冻结真实请求及对应历史回复，分开 observation/summary；用公共 import/score/review/report。检查来源支持、关键事实保留、指标/阶段/完成状态、字段完整性，以及生成和真实入库结果。
- **快速回归**：默认运行已核实发布目录中的 `python "$memcheck_source/scripts/mem_check.py" status` 和 `python "$memcheck_source/scripts/mem_check.py" quick --out <新私有目录>`；可加 `--evidence <已有审计目录>` 回放冻结结果并重算已有标签。只有用户明确指定候选源码时才从该候选运行，并标记为候选回归。
- **验证新提示词或模型效果**：固定同样本、上下文、profile和语义评审标准，使用公共 freeze/plan/prepare/run/import/score/review/report；先明确模型、样本、探针/补救和总调用预算，再在已授权范围内执行。

先看 `llm-eval scenarios` 与实际发布组合。框架使用适配器 wheel 内封装的 bridge/mode，改源码不会自动改变已安装组合；旧实验继续锁原版本。新增过滤汇总器是否已接公共报告必须实际核实，不能从源码文件存在就声称已接入。

过滤质量同时报告：来源批次与任务数、生成数、唯一实际新增数、转化率、无价值输入拦截、有价值输入误拒/未产出、生成及入库的低/无价值混入、旧记忆再采集重复、事实错误、未知和评审覆盖。批次共享outcome按实际新增ID去重，`mergedIntoExisting`是布尔标记，不按数组长度统计合并数。

价值和事实支持分开标注，来源不足不自动等于事实为假；未知不算通过。使用同一业务发布目录中的 `scripts/observer_filter_quality.py` 汇总有证据的标签，不把规则分类当完整语义真值。

默认不新增模型调用、不写真实记忆、不切生产模型。离线解析回放不证明新提示词收益；未完成独立评审或策略未校准，不签生产准入。原始输入/回复保留在私有产物，不完整回显到终端或聊天。

详细操作与计量合同读业务发布目录中同版本的 `docs/observer-model-bench.md`；语义固定案例读该目录的 `docs/observer-semantic-regressions.md`。本技能不启用 claude-mem:do 或 claude-mem:build。

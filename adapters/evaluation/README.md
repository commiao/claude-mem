# claude-mem 业务适配器

先从已批准的业务源码执行 `python scripts/build-eval-adapter.py`，再从本目录构建 wheel。
包内带独立 Bun bridge、code mode 和来源指纹；只需要 Bun 和公共 `llm-eval` 包，不依赖 checkout。
桥接使用临时私有数据目录；不启动 worker、不打开生产数据库、不通知、不落真实记忆。

`claude_mem.observation` 与 `claude_mem.summary` 是独立评测场景。
摘要的生产模型路由仍为现有 `claude_mem.observation`，不新增生产业务路由。
组批与 worker 共用 ObserverBatchRequest：20条、64000字节整请求、4096输出token，
实际 JS JSON.stringify 字节计量；遵守会话/context/prompt_number/agent 边界。
summary 的历史 observations 冻结且限制20条/12000字节，不查未来数据。

纯结果处理与生产 ResponseProcessor/GatewayObserverQueue 共用 ObservationNormalization。
同时报告 parser_valid 和纯归一化结果；数据库存储成功不由评测假定。
captured request 可原样比较，但真实来源组批/effective配置未独立证明时明确标记。
当前仅支持 code mode；其他模式需另行发布适配资源和回归。

正式质量门槛尚未用标注数据校准，故默认不能给生产模型准入。
词面 anchors 仅诊断，字符压缩比不是 token 压缩比，事实/状态/来源支持仍需独立盲评。

0.1.1 复用公共核心的 JSON 子进程协议（需要 llm-eval>=0.1.1,<0.2）：完整写出、
请求绑定、UTF-8 字节长度和摘要校验属于公共包，业务桥只负责组批/解析/归一化。
传输失败计为基础设施阻塞，不能归因于模型输出质量；不会自动补调模型。

指标策略 `mem-unvalidated-2` 的字符比分母为冻结业务来源的 JSON 字符数
（`ensure_ascii=False`，Python 默认 JSON 分隔符）：user_prompt、records、request、
last_assistant_message、persisted_observations、context 中实际存在的字段。
它包含摘要的历史观测上下文，排除标签、样本 ID、split 等评测元数据。
分子仍为归一化结果的 JSON 字符数；这是诊断性的存储表示比例，不是提示词 token 比率。
历史报告保留原策略/原字节，复算另存文件并关联原计划与回复哈希，不冒充重新运行模型。

# Agent Note: 仓库外会话事件承载机制

Status: implemented

[English](2026-08-17-out-of-repository-session-event-carrier.md) | 中文

## Problem

`SessionEventMap` 声明合并可以为仓库外插件提供编译期事件类型，但第一方生成的 `KNOWN_SESSION_EVENT_TYPES` 不可能包含该插件。因此，必需的未知事件会让下一次持久化读取拒绝会话；若把运行时注册直接加入已知集合，普通检查又会依赖当前挂载的组合。[会话日志版本机制](2026-08-10-session-log-version-mechanism.zh.md)有意把此情形推迟到真实消费者需要持久插件状态时再处理。

owner 插件缺失时，会话仍必须能够检查、查询和导出。当忽略该插件会丢弃必需状态时，实时继续运行必须拒绝；SQLite 后缀读取也不能依赖更早的一条声明记录。

## Decision

`dsh-session` 拥有一种核心认识、仅记录日志的 `session-extension/event` carrier。每条 carrier 都重复稳定 owner、owner 定义的事件类型、正整数 schema 版本、`required` 或 `ignorable` 继续运行要求，以及无损 JSON 载荷。ignorable carrier 还携带信封字段 `ignorable: true`；required carrier 绝不携带。carrier 在每个序号位置都能自描述，因此 `readFrom()` 可以返回可独立解释的后缀。

`SessionStore.registerEventExtension()` 在调用方作用域注册精确描述符，并返回由 fiber 所有的 handle。handle 通过 `Session.append()` 为 carrier 数据制作快照，释放后拒绝调用，并拒绝写入捕获作用域看不到该描述符的目标会话。同一作用域中的相同注册可以共存以支持重载重叠；该层中发生 schema 版本或 requirement 冲突时会失败，且不会替换活动注册。

持久化检查、加载、后缀读取、崩溃修复和脱离态准备把 carrier 当作普通核心已知数据，绝不查询注册表。`SessionStore.enter()` 在发布前按调用方作用域检查 required carrier 并捕获该作用域；`announce()` 在创建边之前立即复查。实时轮次中 required 注册消失时不会阻止 `turn/end`，但下一次 `turn/start` 会在提交前检查并拒绝，直到精确注册恢复。fork 发布经过相同检查；若 fork 边界位于第一条 required carrier 之前，则无需注册。

首个实现采用精确兼容：owner、事件类型、schema 版本和 requirement 全部匹配。`SessionExtensionCompatibilityError` 将无法在目标组合运行的有效日志，与不支持的会话格式或损坏数据区分开。

## Alternatives considered

**把插件事件名加入运行时已知集合。** 这会让 `inspect`、`load` 和 `readFrom` 的成功与否取决于当前组合，并重新制造版本机制已经拒绝的精简读取器与完整读取器不一致。

**先持久化一条声明，再写后续插件事件。** 从该声明之后开始的 SQLite `readFrom()` 无法在不读取前缀的情况下解释返回后缀，会破坏后缀约定和投影缓存用例。

**把注册表交给可选元插件。** 直接调用 `SessionStore.create()`、`fork()`、`enter()` 和 `turn/start` 仍需要 `dsh-session` 中不可缺少的准入检查；把注册表留在那里可以消除可选旁路，同时仍让插件扩展 session 插件。

**把插件状态存入第二账本或工作区文件。** 这会失去原生 fork 谱系、会话范围恢复和单一仅追加权威，并让模型可见投影需要另一条同步路径。

**把所有外部事件都标为 ignorable。** owner 缺失时可能静默恢复，而决定未来控制动作的状态已经丢失。writer 必须按描述符作出这一承诺，不能获得宽松默认值。

## Verification

包测试固定 carrier 校验与冻结、带作用域注册生命周期、冲突注册、enter／announce 回滚、卸载后的轮次准入、跨作用域拒绝和 fork 边界。共享持久化约定在 owner 插件缺失时，经内存、JSONL、Zstandard JSONL 和 SQLite 操作往返 required 与 ignorable carrier。Agent-loop 恢复测试证明脱离态检查成功、缺少 required 注册会阻止发布，而且带作用域的 setup 可以在 `enter()` 前安装精确描述符。

## Consequences

carrier 添加的是普通事件类型，不改变会话信封、JSONL 编码、SQLite schema 或 `SESSION_FORMAT_VERSION`。旧读取器会跳过 ignorable carrier，并把 required carrier 作为未知必需事件拒绝，从而保留已有失败方向。

required carrier 会永久使其精确描述符成为包含它的每个前缀实时继续运行的条件。版本集合、载荷升级器、通用依赖解除和专用 Web 呈现继续推迟，直到另一位消费者提供可测试的具体行为。owner 插件继续拥有载荷校验、fold、投影和关系不变量；注册只建立可用性，不建立语义正确性或执行权限。

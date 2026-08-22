# Agent Note: 交互 actor 溯源与最后一跳准入

Status: implemented

[English](2026-08-22-interaction-actor-provenance-and-last-mile-admission.md) | 中文

## 问题

仅有审批结果既不能标识选择它的 actor，也不能说明命令是否来自宿主能够证明的交互。通用客户端能够回答 API 请求，而 extension 注册可能在异步工具或命令准入已经开始后消失。把任一情况视为授权，会让策略错误在持久化状态已经表示继续运行不兼容后仍进入 body。

## 决策

`dsh-user-approval` 拥有封闭的 `InteractionActor` 词汇与持久化 `ApprovalDecision` 视图。`approval/asked.requiredActor` 与 `approval/decided.decidedBy` 是可追加的持久化字段。监听器不能提交这种结构；静态宿主适配器会创建 `ApprovalIngress`，其不透明答案绑定 exact service、冻结请求、owner 作用域与 owner fiber。`ApprovalService` 为普通审批接受 legacy 结果，但当要求 `interactive-user` 时，会在返回前把 bare 或不匹配的 `allowed-once` 转为 `unavailable`。`isActorQualifiedApprovalGrant()` 为回放消费者提供同一失败关闭谓词。

`dsh-commands` 将 legacy 直接执行记录为 `unattributed`；历史 `user` 来源仍可读取，但没有 actor 含义。静态宿主适配器从 `createCommandIngress(owner, actor)` 获得不透明 `CommandIngress`，并调用 `executeTrustedCommand()`。运行时将 actor 存在命令 wire 之外，把 capability 限制在其 owner 作用域内，随 owner fiber 失效，并将捕获的 actor 写入 `command/run`。这些宿主 helper 是根模块导出，不是 Cordis service 或 Remote 方法。

通用 API proxy 写入 `external-client/api`，ACP 写入 `external-client/acp`。两种传输都不能证明交互手势，当前也没有随产品交付的 CLI 适配器铸造 `interactive-user`。需要该 actor 的部署组合带有自身可验证手势边界的专用 UI 或 TTY ingress。

动态 Host package 接收 capability façade，而不是真实 Cordis service、Agent 或 Session。service symbol、descriptor 与 prototype 都不会暴露原始实现；event 和 handler 参数只包含 allowlist 只读 Agent／Session 视图，因此动态代码不能通过 `Session.append` 或私有 log 状态制造带 actor 的会话记录。

`SessionStore.assertLiveEventExtensionsCompatible()` 通过 `enter()` 时捕获的作用域检查实时会话。`ToolRuntime` 在所有异步准入完成后、`ToolDefinition.execute` 前立即调用它；`CommandRuntime` 在 handler 前执行等价检查。命令还拥有 `ctx.commands.guard()`，即作用域感知的同步单调拒绝 seam。因此 extension 的迟到丢失允许命令产生审计错误对，却不会启动命令 handler 或工具 body。

## 曾考虑的替代方案

- **从用户消息或传输名称推断人类**：否决。二者都不能证明对精确的后续动作的批准或实时 UI 手势。actor 只由同进程宿主 ingress 代码铸造，绝不来自审批或命令 wire 数据。
- **让 legacy 记录不兼容**：否决。既有会话日志保持可读取；它们缺失的 actor 有意不足以满足 actor-required 消费方。
- **从全局运行时上下文检查 required extension**：否决。agent 作用域注册属于会话 entry 捕获的作用域，而非 `ToolRuntime` 或 `CommandRuntime` 的全局服务上下文。
- **为最终命令拒绝使用可重排的 waterfall**：否决。后续监听器可能覆盖或绕过策略。命令 guard 与工具 guard 一样，只返回拒绝理由。

## 后果

需要人类的消费者能够把持久化审批或直接命令绑定到宿主证明的 actor，而不创建第二持久化账本。既有普通审批和直接命令调用方继续可用，但不能满足人类 authority。required extension 的卸载、HMR 与重新安装在分发边界检查，而不是只在轮次打开时检查；已经进入 body 的工作仍是协作式的，无法追溯取消。缺少交互 ingress 是明确的产品工作，不是 ECC 或其他消费者可以重新解释的传输标签。

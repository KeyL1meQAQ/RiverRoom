# 采用 PokerKit 作为扑克规则引擎

无限注常规桌需要完整支持短码全下、加注权、边池、UTG Straddle 和发两次牌。选择 React、Vite、TypeScript 前端与 Python FastAPI、PokerKit 后端，并使用 PostgreSQL 持久化、Docker Compose 部署。PokerKit 已有 Straddle、多次发牌及边池支持，可以复用完整规则逻辑；候选 TypeScript 引擎需要修复规则并增加扩展，因此接受前后端采用不同语言的成本。

应用仍负责匿名身份、审批、筹码账本、计时、全员同意投票、权限过滤和恢复持久化，不能将引擎牌局历史直接视为完整房间存档。首版每个房间串行处理命令，目标同时运行 20 个房间。选型基于文档及源码调研，具体规则和恢复能力仍须通过验收测试验证。

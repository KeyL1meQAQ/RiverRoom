# 技术方案

状态：技术选型已确认。此文记录调研结论及实现约束，不代表已经实现或通过测试。

## 已确认方案

- 前端：React、Vite、TypeScript，支持桌面与手机竖屏。
- 后端：Python、FastAPI、PokerKit，服务端裁定全部牌局行为，通过 WebSocket 同步各参与者可见状态。
- 存储：PostgreSQL，保存房间、身份、筹码账本、私密牌序及已确认行动。
- 部署：Docker Compose，初版单个游戏服务实例，为每个房间串行处理命令；容量目标为 20 个同时运行的房间。

## 规则库调研

PokerKit 0.7.5 使用 MIT 许可证，要求 Python 3.11 或更新版本，PyPI 发布日期为 2026-08-22。官方示例覆盖 Straddle 与多次发牌；引擎支持主池、边池和逐操作推进，并包含牌型计算。推荐复用完整规则引擎。

poker-ts 1.5.0 是 TypeScript 下注引擎，使用 MIT 许可证，但公开接口没有完整覆盖本项目需要的 Straddle、多次发牌和恢复。源码检查还发现其对短码全下直接更新最小加注幅度，合法行动判断缺少已行动者是否重新获得加注权的处理；尚未运行复现测试。因此不推荐原样采用。

pokersolver 2.1.4 仅负责牌型比较，不负责下注顺序、加注权、边池和多次发牌，不能替代本项目的规则引擎。

## 仍需实现的产品逻辑

匿名身份、设备接管、入座和补码审批、座位管理、房主权限、筹码账本、TimeBank、断线与 AWAY 都由应用负责。

发两次牌需要独立的全员同意流程。PokerKit 的无偏好值不等同于拒绝；本产品的超时必须明确按只发一次处理。

PokerKit 的牌局历史可保存及重放，但不能直接当成完整房间恢复方案。需要额外持久化完整私密牌序、已确认操作、计时、投票和房间状态；恢复时重放已确认操作并核对状态。客户端只接收属于自身权限的状态，不能接收完整牌堆或其他玩家未公开底牌。

命令须去重并检查房间版本与行动轮次，确保旧设备、刷新重试或迟到操作不会重复下注或作用于下一次行动。持久化成功后才确认操作；恢复后的结算与买出不能重复记账。

实现前后的重点验收场景包括短码全下与加注权、多重边池、两次发牌分池及奇数筹码、固定牌序的重启恢复、设备接管和计时恢复。当前调研没有安装依赖或执行这些测试。

## 来源

- [PokerKit 官方仓库及示例](https://github.com/uoftcprg/pokerkit)
- [PokerKit PyPI 元数据](https://pypi.org/pypi/pokerkit/json)
- [PokerKit 引擎实现](https://github.com/uoftcprg/pokerkit/blob/main/pokerkit/state.py)
- [PokerKit 历史保存与重放](https://github.com/uoftcprg/pokerkit/blob/main/docs/notation.rst)
- [poker-ts API](https://github.com/claudijo/poker-ts)
- [poker-ts 下注轮实现](https://github.com/claudijo/poker-ts/blob/main/src/lib/betting-round.ts)
- [pokersolver 能力说明](https://github.com/goldfire/pokersolver)

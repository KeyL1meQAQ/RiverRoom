# PokerNow 风格房间 UI 重构

2026-09-28。需求与验收边界分别见 `docs/requirements.md` 第 157–163 项、`docs/acceptance.md` 的同名小节。

## 参考和取舍

用户提供 `IMG_3394.PNG`、`IMG_3395.PNG`、`IMG_3396.PNG` 三张 PokerNow 手机浏览器截图，分别覆盖离开、下注和摊牌。另核查 [PokerNow 官方桌面牌桌图](https://cdn.pokernow.com/club-game-browser-game-7c85d126e974665e92d0-20547581d602.png)和[官方教程](https://www.pokernow.com/blog/no-download-poker-with-friends-tutorial)。同名应用的其他产品图片没有混入参考。

手机采用纵向圆角长桌，电脑采用横向椭圆桌；保留 River Room 品牌、中文、固定九席、5:7 扑克牌和所有现有玩法。自由文字聊天、语音视频没有加入本轮。旧需求中的浅色名牌、手机椭圆桌、常驻加注滑杆与取消名牌获胜金额，由本轮确认的第 157–160 项覆盖。

## 实现范围

- `src/main.tsx`：菜单及桌外入口、加注展开与二次确认、派彩后名牌获胜金额。
- `src/poker-now-room.css`：房间内统一视觉层；大厅和创建页不采用该样式。
- `tests/*.spec.ts`：新菜单路径、获胜金额、加注操作和九席布局回归。

## 验证记录

本地 `npm run build` 通过；`.venv/bin/python -m pytest backend/tests -q` 为 238 项通过；使用独立 SQLite `/Users/keyl1me/Documents/Codex/2026-09-28/files-mentioned-by-the-user-img/work/room-ui-test.sqlite` 与本地 Uvicorn 端口 8042，`BASE_URL=http://127.0.0.1:8042 npm run test:e2e -- --max-failures=1` 为 71 项通过（约 3.8 分钟）；`git diff --check` 通过。

浏览器回归中，真实本地多人房间验证入座、审批、下注、刷新、身份召回、摊牌及互动；合成状态测试覆盖 320/360/390/760/761/1024/1366/1440px 的九席、双公共牌、长昵称、大额、成就徽章、行动胶囊、牌面比例和派彩阶段。加注专项验证展开与取消不发送命令，确认后才发送当前加注金额。测试截图存于本地 `artifacts/`；供本次任务查看的三张图片另存于任务输出目录。

这些结果证明本地浏览器和后端回归通过。没有进行生产部署、线上房间验收或真实手机设备验证。

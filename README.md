# River Room

无需注册的多人无限注德州扑克常规桌。房间链接邀请、观战和入座审批、浏览器身份与召回码、UTG Straddle、全员同意的发两次牌、TimeBank、重买入、筹码账本和历史记录均已接入实际服务端。

公共牌逐张发出并配有可静音的音效，发牌期间不消耗行动时间。摊牌结果按公共牌组和底池展示赢家牌型及最佳五张牌，支持平分者同时高亮和历史回看；本人当前成牌仅自己可见，弃牌后继续更新。

## Docker Compose

服务器部署地址和维护命令见 [部署说明](docs/deployment.md)。

需要 Docker Engine 与 Compose。应用由一个游戏服务进程串行处理每个房间的命令，数据库为 PostgreSQL 17。

```sh
docker compose up --build -d
```

浏览器打开 http://localhost:8080 。数据库使用持久卷；不要在需要保留房间时执行带 `-v` 的 Compose 清理。对外部署时通过 `POSTGRES_PASSWORD` 设置数据库密码，使用 HTTPS 反向代理，并保留原始 Host 及 WebSocket 升级头。

## 本地开发

需要 Node.js 22+、Python 3.11+。已验证的环境为 Node.js 24、Python 3.12、PostgreSQL 17。

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
npm ci
docker compose up -d db
```

后端：

```sh
DATABASE_URL=postgresql+psycopg://poker:local-poker-development@127.0.0.1:55432/poker ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 .venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

前端：

```sh
npm run dev -- --port 5173
```

浏览器打开 http://localhost:5173 。手机可通过同一局域网的主机 IP 访问；使用 Vite 开发代理时，将该完整页面来源追加到 `ALLOWED_ORIGINS`。浏览器身份使用 HttpOnly Cookie；不同浏览器配置文件或无痕窗口可用于模拟不同玩家。

执行 `npm run build` 后，后端也直接提供生产版界面，访问 http://localhost:8000 即可，不需要 Vite 开发代理。当前牌桌行动与电脑布局的预览地址为 http://localhost:8003 ，使用独立的 `data/table-actions-preview.db` SQLite 数据库。

当前机器因 Docker Desktop 无法启动，使用 Homebrew PostgreSQL，连接地址为 `postgresql+psycopg://keyl1me@127.0.0.1:55432/poker`。PostgreSQL 进程监听本机回环地址。开发及单元测试未设置 `DATABASE_URL` 时可使用 `data/poker.db` SQLite 文件；Docker 配置始终使用 PostgreSQL。

## 验证

```sh
.venv/bin/python -m pytest backend/tests -q
npm run build
npx playwright install chromium
npm run test:e2e
.venv/bin/python scripts/load_rooms.py
```

端到端测试要求前后端已启动，默认访问 `http://localhost:5173`。并发脚本默认访问 `http://127.0.0.1:8000`，创建 20 个房间、连接 40 位参与者，完成牌局后关闭测试房间。二者可通过 `BASE_URL` 覆盖地址。截图与失败跟踪写入 `artifacts/` 和 `test-results/`。

## 结构

- `backend/engine.py`：PokerKit 适配、固定牌序重放、奇数筹码策略。
- `backend/hands.py`：复用 PokerKit 生成牌型文字及获胜五张牌。
- `backend/game.py`：房间状态机、审批、下注、计时、账本和公开状态过滤。
- `backend/app.py`：HTTP、WebSocket、设备接管、串行持久化及定时任务。
- `backend/store.py`：事务性房间快照及乐观版本检查。
- `src/`：桌面与手机界面。
- `docs/requirements.md`、`docs/acceptance.md`：已确认规则和验收目标。
- `docs/adr/`：匿名身份、恢复和规则引擎的决策记录。

## 状态与恢复

已确认操作先写入数据库再向客户端确认；重复命令和旧行动轮次不会重复下注。牌序与引擎操作仅存于服务端，公开消息按参与者权限过滤。

服务重启后恢复原手牌并暂停，房主继续时当前行动者重新获得基本 20 秒，TimeBank 保留已保存余额。发两次牌的已提交选择保留。房间关闭后保留记录 30 天。

当前版本必须以单个游戏服务进程运行。请勿直接增加 Uvicorn worker 或复制游戏服务实例；跨实例调度尚未实现。现有数据库版本检查能拒绝冲突写入，但不能替代跨实例房间所有权管理。

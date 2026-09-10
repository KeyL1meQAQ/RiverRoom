# River Room

面向朋友组局的在线无限注德州扑克常规桌。无需注册，创建房间、分享链接即可邀请朋友观战和申请入座，支持电脑与手机浏览器。

项目仅记录游戏筹码和输赢，不提供充值、支付、提现或平台抽水。

![River Room 九人牌桌](docs/images/table-desktop.png)

*桌面端九人牌桌，截图使用测试身份与测试牌局。*

## 功能

- **邀请与身份**：分享房间链接、观战、房主审批入座；浏览器身份自动恢复，房间专属召回码支持换设备接管。
- **完整牌局**：2–9 人常规桌，支持下注、加注、全下、边池和平分底池；可选 UTG Straddle 与全员同意的发两次牌（Run It Twice）。
- **节奏与管理**：20 秒基本行动时间、可配置 TimeBank、AWAY、补码与重买入、暂停后续发牌、房主转让及离座结算。
- **牌桌呈现**：逐张公共牌动画、可静音音效、本人当前成牌提示、摊牌赢家与最佳五张牌高亮、自愿亮牌。
- **账本与历史**：公开行动日志、买入买出与净输赢统计、CSV 导出、按手回看底池分配和已公开底牌。
- **持久化与恢复**：已确认操作写入数据库，支持断线重连、重复命令去重；服务重启后恢复原手牌并暂停，等待房主继续。

## 快速启动

推荐使用 Docker Compose，一次启动前端、后端与 PostgreSQL。需要 Git、Docker Engine（或 Docker Desktop）和 Docker Compose。

```sh
git clone https://github.com/KeyL1meQAQ/RiverRoom.git
cd RiverRoom
docker compose up --build -d
```

打开 [http://localhost:8080](http://localhost:8080)。首次启动需要下载镜像和依赖。

```sh
# 查看服务状态和健康检查
docker compose ps
curl --fail http://localhost:8080/api/health

# 停止服务，保留数据库卷
docker compose down
```

开发 Compose 的默认数据库密码仅供本地使用。数据库保存在 Docker 持久卷中；需要保留房间时，不要执行 `docker compose down -v`。

### 开始一桌

1. 创建房间，设置盲注和可选玩法，复制邀请链接给朋友。
2. 进入房间后先观战；选择空位、填写昵称和买入筹码，提交入座申请。
3. 房主审批其他人的申请，房主自己的入座申请自动批准。
4. 至少两名玩家就座后，由房主开始第一手牌。

同一浏览器配置文件在同一房间使用同一身份。模拟多个玩家时，请使用不同浏览器配置文件或相互独立的浏览器会话。

召回码不是邀请链接：持有码的人可以接管该房间内的身份，接管后旧设备失去操作权，召回码随之轮换。请仅本人保管；浏览器身份与召回码同时丢失时，不能凭昵称恢复。

## 本地开发

建议使用 Node.js 22+、Python 3.11+；项目 Docker 镜像使用 Node.js 24 和 Python 3.12。以下命令适用于 macOS / Linux，在仓库根目录执行。

### 安装依赖

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
npm ci
```

### 启动后端

默认使用 SQLite，首次启动自动创建 `data/poker.db`，无需另行安装数据库：

```sh
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
  .venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

### 启动前端

在另一个终端中执行：

```sh
npm run dev -- --port 5173
```

打开 [http://localhost:5173](http://localhost:5173)。Vite 将 `/api` 与 `/ws` 代理到 `127.0.0.1:8000`，开发时保持两个进程运行。

手机可通过同一局域网中的电脑 IP 访问，例如 `http://192.168.1.10:5173`。请将实际使用的完整页面来源追加到后端的 `ALLOWED_ORIGINS`，并重启后端。

### 使用 PostgreSQL

如需与 Compose 环境保持一致，可启动 PostgreSQL 17，并在启动后端的终端设置连接地址：

```sh
docker compose up -d db
export DATABASE_URL='postgresql+psycopg://poker:local-poker-development@127.0.0.1:55432/poker'
```

随后执行上面的后端启动命令。若自定义了 `POSTGRES_PASSWORD`，连接地址中也需要使用对应密码。开发数据库端口仅绑定本机回环地址。

### 构建生产界面

```sh
npm run build
```

构建产物位于 `dist/`。构建完成后启动或重启后端，即可直接访问 [http://localhost:8000](http://localhost:8000)，此时无需启动 Vite。

## 配置

| 变量 | 用途 | 默认值 / 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 后端数据库连接 | `sqlite:///data/poker.db`；Compose 使用 PostgreSQL |
| `ALLOWED_ORIGINS` | 后端额外允许的请求来源 | 逗号分隔完整来源；默认允许与请求 Host 相同的来源 |
| `POSTGRES_PASSWORD` | Compose 数据库密码 | 开发配置有本地默认值；生产配置必须显式设置 |
| `PORT` | 开发 Compose 的应用宿主端口 | `8080`；不改变直接运行 Uvicorn 的端口 |
| `BASE_URL` | 浏览器测试或并发脚本的目标地址 | Playwright 为 `http://localhost:5173`；并发脚本为 `http://127.0.0.1:8000` |
| `PIP_INDEX_URL` | 生产镜像构建使用的 Python 包索引 | 默认 `https://pypi.org/simple` |

直接运行 Uvicorn 时，通过 shell 环境传入配置，应用不会自动读取 `.env`。Docker Compose 支持 `.env` 或 `--env-file`；本地环境文件、数据库、依赖和构建产物均已加入 `.gitignore`。

## 测试与验证

后端测试与前端类型检查、构建：

```sh
.venv/bin/python -m pytest backend/tests -q
npm run build
```

浏览器端到端测试需要先启动上述前后端服务：

```sh
npx playwright install chromium
npm run test:e2e
```

也可以对已启动的本地 Compose 实例执行：

```sh
BASE_URL=http://localhost:8080 npm run test:e2e
```

并发检查脚本会创建 20 个测试房间、连接 40 个 WebSocket 客户端，完成牌局、核对筹码并关闭房间：

```sh
BASE_URL=http://127.0.0.1:8000 .venv/bin/python scripts/load_rooms.py
```

请将这类会创建房间的检查指向测试环境。20 个房间是脚本验证规模，不是长期容量保证。主动截图写入 `artifacts/`，浏览器测试失败截图和跟踪文件写入 `test-results/`。

## 运行边界

- **单进程游戏服务**：房间命令在进程内按房间串行处理。当前不能增加 Uvicorn worker 或复制游戏实例；数据库版本检查不能替代跨实例的房间所有权管理。
- **恢复与暂停**：常规暂停只停止后续发牌，当前手牌继续；服务重启后的恢复暂停需要房主继续，当前行动者重新获得基本 20 秒，TimeBank 保留已保存余额。
- **房间与记录**：连续 24 小时无人在线的房间进入结束流程；关闭后的记录保留 30 天。房主离线不会自动转让权限。
- **产品范围**：仅支持常规桌，不包含锦标赛、自动涨盲或保险。筹码仅用于游戏记账。
- **手机布局**：密集座位同时显示行动提示时仍有已知的碰撞场景，详见[验证记录](docs/verification.md)。

公网部署使用 `compose.production.yaml` 与 `deploy/`，需先在本地执行 `npm ci`、`npm run build`，生产 Dockerfile 会复制现成的 `dist/`。应用只映射到 `127.0.0.1:18080`，数据库不发布宿主端口；由反向代理提供 HTTPS，并转发原始 Host 和 WebSocket 升级头。部署与备份流程见[部署说明](docs/deployment.md)，其中包含既有环境的配置，部署到其他机器时需按实际环境调整。

## 技术栈与目录

前端使用 React、TypeScript、Vite；后端使用 FastAPI、WebSocket 与 PokerKit，数据通过 SQLAlchemy 持久化至 PostgreSQL 或 SQLite。

| 路径 | 内容 |
| --- | --- |
| `src/` | 牌桌界面、交互、牌型呈现和响应式样式 |
| `backend/app.py` | HTTP / WebSocket、身份接管、持久化与定时任务 |
| `backend/game.py` | 房间状态机、审批、下注、计时、账本与权限过滤 |
| `backend/engine.py` | PokerKit 适配、固定牌序重放与奇数筹码分配 |
| `backend/hands.py` | 牌型文字与获胜五张牌 |
| `backend/store.py` | 事务性房间快照与版本检查 |
| `backend/tests/`、`tests/` | 后端测试与 Playwright 浏览器测试 |
| `scripts/load_rooms.py` | 多房间并发功能检查 |
| `deploy/` | 生产镜像与 Nginx 配置 |

## 项目文档

- [领域术语](CONTEXT.md)：参与者、召回码、补码、重买入、AWAY 等概念。
- [需求与规则](docs/requirements.md)：已确认的玩法与交互规则。
- [验收目标](docs/acceptance.md)：功能验收范围。
- [技术方案](docs/technical-proposal.md)：架构与持久化设计。
- [架构决策](docs/adr/)：匿名身份、进行中手牌恢复与规则引擎选型。
- [验证记录](docs/verification.md)：各次验证环境、结果及已知限制。
- [部署说明](docs/deployment.md)：部署、备份、更新与回滚。

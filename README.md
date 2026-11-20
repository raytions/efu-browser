# Everything File Browser (`efu-browser`)

一个面向 Everything `.efu` 文件列表的纯静态网页浏览器，现已扩展为**可自托管的 Linux/NAS 文件名搜索工具**，并提供 **Scans 双模式（演示模式 / 自托管真实模式）**：

```text
Linux 本地目录 / 已挂载的 SMB 或 NFS 共享
  → gdu（开源目录扫描器，已验证 v5.39.0）
  → scripts/efu-scan.mjs（校验、路径前缀映射、EFU 转换、原子发布）
  → 同源 HTTP 发布 /indexes/*.efu、config.json（及可选受控 /api/scans）
  → efu-browser 浏览器端解析、搜索、排序、分页与目录浏览
```

同时**完整保留 GitHub Pages 纯静态部署与手动导入本地 `.efu` 文件**的原有用法。EFU 是平台无关接口：Linux 使用 `gdu` 链路，Windows 端可继续使用 Everything 或 EFUtool 导出 `.efu`，直接导入网页或放入受保护的索引目录。

---

## 核心特性

- **零构建静态前端**：原生 HTML / CSS / JS，兼容根路径与 GitHub Pages `/efu-browser/` 子路径部署。
- **可选服务器索引（`config.json`）**：无需重新打包前端即可声明一个或多个同源 `.efu` 快照，支持切换、重新加载、HTTP `Last-Modified` 快照修改时间展示、失败保留旧结果与快速切换防竞态。默认空配置不请求任何 `.efu` 或 `/api/scans`。
- **Scans 双模式（`SCANS_MODE=demo|real`）**：
  - **演示模式（`demo`，默认 / GitHub Pages）**：纯前端内存模拟，显著标注「演示模式：这是模拟扫描，不会访问你的设备、服务器或 NAS。」使用虚构快照 `demo/demo-before.efu`（5 条）与 `demo/demo-after.efu`（6 条，新增 `demo-slide-003.svs`），绝不请求 `/api/scans`。
  - **真实模式（`real`，自托管 Docker / Node）**：连接独立受控扫描 API（`scripts/scans-service.mjs`），展示受控任务列表、状态、上次成功时间、条目数和脱敏错误摘要，支持按需触发（需显式 `SCANS_ALLOW_TRIGGER=true`）并点击「打开结果」加载 `/indexes/{id}.efu`；后端不可用时显示可读错误，绝不回退到演示模式。
- **Linux/NAS 扫描到 EFU 适配层（`scripts/efu-scan.mjs`）**：
  - 复用 `gdu`（已验证 `v5.39.0`）保留表观文件大小（`Size`）与修改时间（`Date Modified`，Windows FILETIME）。
  - 严格校验退出码、stderr、`gdu` 日志与 JSON `read_error` 标记，拒绝把权限错误或截断输出发布为快照。
  - 支持目录剪枝排除（`--exclude`）、基于 `/proc/self/mountinfo` 的真实挂载点双重校验（`--require-mount`）、边界安全的导出路径前缀改写（`--export-prefix`），以及同目录临时文件 + `fsync` + `rename` 原子发布。
- **主题与界面**：支持跟随系统 / 亮色 / 暗黑（参考 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 中性深色体系）主题切换，支持模糊/通配符/正则搜索、`file:`/`path:`/`!` 语法、列显示控制与双击复制路径。

---

## 最短自托管步骤（从扫描 `/mnt/nas/projects` 到网页搜索）

### 方式一：仅定时 CLI 扫描 + 静态 Web（`SCANS_MODE=demo`，默认）

#### 1. 安装已验证的扫描器 `gdu`（v5.39.0+）与 Node.js（>= 20）

```bash
curl -fsSL https://github.com/dundee/gdu/releases/download/v5.39.0/gdu_linux_amd64_static.tgz \
  | tar -xz -C /tmp
sudo install -m 0755 /tmp/gdu_linux_amd64_static /usr/local/bin/gdu
gdu --version
```

> 说明：`gdu v5.39.0` 起在 JSON 导出中原生输出 `"read_error": true` 标记不可读目录；适配层同时校验 `gdu` 日志文件、退出码与 JSON 结构，确保部分扫描不会被静默覆盖为正式快照。

#### 2. 扫描 `/mnt/nas/projects` 并原子发布 EFU 快照

```bash
mkdir -p ./indexes

node scripts/efu-scan.mjs \
  --root /mnt/nas/projects \
  --output ./indexes/projects.efu \
  --exclude .snapshot \
  --exclude @eaDir \
  --require-mount /mnt/nas \
  --export-prefix '\\nas\projects'
```

#### 3. 准备运行时网页配置（无需重新构建前端）

使用 [`deploy/config.example.json`](deploy/config.example.json) 作为基础配置：

```json
{
  "defaultIndex": "projects",
  "indexes": [
    {
      "id": "projects",
      "name": "NAS 项目目录",
      "url": "indexes/projects.efu"
    }
  ]
}
```

#### 4. 启动同源 Web 容器（Docker Compose）

```bash
EFU_INDEX_DIR=./indexes \
EFU_CONFIG_FILE=./deploy/config.example.json \
  docker compose -f docker-compose.env.yml up -d --build
```

默认仅监听 `127.0.0.1:8080`，访问 <http://127.0.0.1:8080>（或经反向代理认证后访问）即可搜索 `NAS 项目目录`。

---

### 方式二：自托管 Docker 真实模式（`SCANS_MODE=real`，含受控扫描 API）

当希望在 Scans 页面查看真实任务状态并（可选）从网页触发服务器端扫描时，通过环境变量与 Compose `real-scans` profile 启用：

#### 1. 准备受控扫描任务配置 [`deploy/scans.example.json`](deploy/scans.example.json)

```json
{
  "tasks": [
    {
      "id": "projects",
      "name": "NAS 项目目录",
      "root": "/mnt/nas/projects",
      "allowedRoot": "/mnt/nas",
      "mountPoint": "/mnt/nas",
      "excludes": [".snapshot", "@eaDir"],
      "exportPrefix": "\\\\nas\\projects",
      "outputName": "projects.efu",
      "enabled": true,
      "schedule": "0 3 * * *"
    }
  ]
}
```

#### 2. 配置环境变量（参考 [`.env.example`](.env.example)）并启动双容器

```bash
cp .env.example .env
# 在 .env 中设置：
#   SCANS_MODE=real
#   SCANS_API_BASE=/api/scans
#   SCANS_ALLOW_TRIGGER=true      # 默认 false（仅查看状态，POST /run 返回 403）
#   SCANS_TASKS_FILE=/config/scans.json
#   SCANS_INDEX_DIR=/app/indexes
#   EFU_GDU_BIN=/usr/local/bin/gdu
#   NAS_SOURCE_DIR=/mnt/nas

docker compose -f docker-compose.env.yml --profile real-scans up -d --build
```

#### 3. 完整使用闭环

1. 浏览器访问 <http://127.0.0.1:8080/#/scans>（请通过反向代理做好认证保护）。
2. 页面顶部显示「真实模式」，列出 `NAS 项目目录` 任务及其状态、上次成功时间、条目数和错误摘要。
3. 点击「立即扫描」→ Nginx 同源反代 `POST /api/scans/projects/run` 至内部 `efu-scanner` 容器 → 后端使用参数数组调用 `node scripts/efu-scan.mjs` + `gdu` 原子发布 `/app/indexes/projects.efu`（运行中重复触发返回 `409`）。
4. 扫描完成后**不会自动覆盖** Browser 当前已打开的索引；点击「打开结果」跳回 Browser 并加载 `/indexes/projects.efu`，使用现有搜索框直接检索新增文件。

> 权限隔离原则：
> - **`efu-browser`（Web/Nginx 容器）**：仅只读挂载 `./indexes:/app/indexes:ro` 与 `/config/config.json:ro`，**绝不挂载原始 NAS 目录**。
> - **`efu-scanner`（扫描 API 容器）**：以非 root `node` 用户运行，**仅对 NAS 源目录只读**（`/mnt/nas:ro`），**仅对受控索引目录可写**（`/app/indexes:rw`），且**不向宿主机暴露端口**，仅通过 Compose 内部网络由 Nginx 反代。

---

## 环境变量说明（Demo / Real 模式切换）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `SCANS_MODE` | `demo` | `demo`（纯前端模拟，不请求 `/api/scans`）或 `real`（连接受控扫描 API）。Docker 启动脚本会自动将其合并进运行时 `/config.json`，并仅在 `real` 模式开启 Nginx `/api/scans` 反代。 |
| `SCANS_API_BASE` | `/api/scans` | 仅 `real` 模式使用，前端请求和服务端监听的同源 API 前缀。 |
| `SCANS_ALLOW_TRIGGER` | `false` | 控制后端 `POST /api/scans/:id/run` 是否允许触发扫描；为 `false` 时后端强制返回 `403`。 |
| `SCANS_TASKS_FILE` | `/config/scans.json` | 扫描服务读取的受控任务配置文件路径。 |
| `SCANS_INDEX_DIR` | `/app/indexes` | 受控 EFU 输出目录；所有 `outputName` 必须为安全文件名且严格限制在此目录内。 |
| `EFU_GDU_BIN` | `gdu`（容器内 `/usr/local/bin/gdu`） | `gdu` 可执行文件路径，沿用 `scripts/efu-scan.mjs` 解析逻辑。 |

### 受控扫描 API 端点（`scripts/scans-service.mjs`）

- `GET /api/scans`：返回 `{ mode: "real", allowTrigger, tasks }`（仅含脱敏后的任务元信息、状态、上次成功时间、条目数、错误摘要与同源 `indexUrl`，不泄露服务器路径、任务内部配置或环境变量）。
- `POST /api/scans/:id/run`：触发已启用任务（`SCANS_ALLOW_TRIGGER=false` 或任务禁用返回 `403`；任务运行中重复触发返回 `409`；正常接受返回 `202`）。
- `GET /api/scans/:id/status`：查询单个任务运行状态。
- `GET /api/scans/:id/index-url`：返回该任务对应的同源 EFU URL 及快照存在标记。
- **重启恢复**：运行状态持久化于 `${SCANS_INDEX_DIR}/.scans-state.json`（Nginx 仅放行 `*.efu`，拒绝访问该文件）；服务重启后若发现遗留的 `running` 状态，会自动恢复为 `failed` 并允许重新触发。

---

## 定时扫描调度示例（无人值守主力更新）

UI 的「立即扫描」只是按需补充，定时快照更新仍建议交给 `systemd timer` 或 `cron`：

### 方式 A：systemd timer（推荐）

仓库内置最小权限模板 [`deploy/efu-scan.service`](deploy/efu-scan.service) 与 [`deploy/efu-scan.timer`](deploy/efu-scan.timer)（`ReadOnlyPaths=/mnt/nas/projects`、`ReadWritePaths=/srv/efu-browser/indexes`）：

```bash
sudo cp deploy/efu-scan.service deploy/efu-scan.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now efu-scan.timer
sudo systemctl start efu-scan.service
journalctl -u efu-scan.service -n 20 --no-pager
```

### 方式 B：cron

```cron
0 3 * * * /usr/bin/node /opt/efu-browser/scripts/efu-scan.mjs --root /mnt/nas/projects --output /srv/efu-browser/indexes/projects.efu --exclude .snapshot --exclude @eaDir --require-mount /mnt/nas --export-prefix '\\nas\projects' >> /var/log/efu-scan.log 2>&1
```

---

## `efu-scan.mjs` CLI 说明、输出与内存边界

| 参数 | 说明 |
| --- | --- |
| `--root <dir>` | 必需。扫描根目录。 |
| `--output <file>` | 必需。目标 `.efu` 路径；临时文件创建在目标同目录，校验通过后 `fsync` + `rename` 原子替换。 |
| `--exclude <pattern>` | 可重复。不含 `/` 时按目录名匹配任意层级（如 `.snapshot`、`@eaDir`）；含 `/` 时按相对 `--root` 的目录路径匹配（如 `sub/cache`）。匹配到的目录会在 `gdu` 阶段整棵剪枝跳过。 |
| `--require-mount <path>` | 可选。通过 `/proc/self/mountinfo` 校验指定路径处于真实已挂载状态且 `--root` 位于其下（扫描前与发布前各校验一次；不保证覆盖所有中途网络瞬断，扫描过程中的 I/O 错误由 `gdu` 的 `read_error` 与日志检查拦截）。 |
| `--export-prefix <prefix>` | 可选。仅改写导出 EFU 中的 `Filename` 前缀（如 `\\nas\projects`），按目录边界拼接相对路径，不改变扫描位置。 |
| `--gdu-bin <path>` | 可选。指定 `gdu` 可执行文件路径（默认读取 `EFU_GDU_BIN` 或 `PATH`）。 |

- **输出列**：`Filename,Size,Date Modified`（UTF-8、RFC 4180 CSV 转义；表观字节数，空文件为 `0`，软链不跟随且不编造大小；修改时间为 Windows FILETIME，不以 `ctime` 冒充创建时间）。
- **空目录行为**：`gdu` 后端仅输出文件条目，因此空目录不会作为独立行出现（合法空根目录会生成仅含表头的 EFU）。
- **内存占用**：`gdu` 会先在内存中构建完整目录树再导出 JSON，适配层也会解析 JSON 树后写出 EFU，因此整条链路峰值内存与条目数呈线性关系 `O(N)`，而非恒定内存。

---

## Demo 模式与真实模式 / CLI 扫描对比

| 维度 | GitHub Pages / `SCANS_MODE=demo` | 自托管 `SCANS_MODE=real` | 定时 CLI（`efu-scan.mjs`） |
| --- | --- | --- | --- |
| 运行位置 | 纯浏览器内存模拟 | 独立受控 `scans-service.mjs` 容器/进程 | `cron` / `systemd timer` |
| 访问文件系统 / NAS | **不访问**任何设备或 NAS | 仅只读访问 `scans.json` 中 `allowedRoot` 内的受控目录 | 只读访问 `--root` 元数据 |
| 请求 `/api/scans` | **绝不请求** | 同源访问 `/api/scans`（默认仅本机/内网或反代认证后） | 无 HTTP API |
| 数据来源 | 虚构静态文件 `demo/demo-*.efu` | 真实扫描并原子发布的 `/indexes/*.efu` | 真实扫描并原子发布的 `/indexes/*.efu` |

---

## GitHub Pages 纯静态部署与 Windows 兼容

- **GitHub Pages**：默认 `config.json` 为 `{"indexes": []}`，打开 Browser 不会发起任何 `.efu` 或 `/api/scans` 请求，支持本地手动导入 `.efu`；访问 `/efu-browser/#/scans` 可直接体验交互式模拟演示（刷新页面也可用）。
- **Windows / macOS 生成 EFU**：在 Windows 上可用 Everything（`文件 -> 导出 -> EFU`）或官方 `EFUtool` 导出 `.efu`，直接本地导入或同步到自托管受保护的 `/indexes/` 目录。

---

## 安全与快照边界（重要）

1. **快照而非实时文件系统**：Browser 搜索的是**最近一次成功发布的 EFU 快照**；扫描失败时原子发布保护会保留上一份可用快照，且不会清空 Browser 当前已加载的结果。
2. **元数据泄露边界**：**任何能够下载某份 `.efu` 文件的人都能看到其中全部文件名与路径**。多人部署必须按权限边界拆分索引，并在 HTTP / 反向代理层同时保护 `config.json`、`/indexes/*.efu` 与 `/api/scans`（如 Basic Auth / Authelia / Authentik / Tailscale），**绝不能依赖前端筛选做访问控制**。
3. **切勿泄露私人快照**：不要把私人 NAS 的 `.efu` 快照或真实 `scans.json` 提交到 Git 仓库（`.gitignore` 默认忽略 `*.efu` 与 `indexes/`），也不要发布到公开 GitHub Pages。

---

## 开发与测试

要求 Node.js >= 20（零外部 npm 依赖），完整端到端测试需安装 `gdu`（已验证 `v5.39.0`）和 Chromium：

```bash
npm run lint
npm test
```

## 开源协议

MIT License。

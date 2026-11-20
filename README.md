# Everything File Browser (`efu-browser`)

一个面向 Everything `.efu` 文件列表的纯静态网页浏览器，现已扩展为**可自托管的 Linux/NAS 文件名搜索工具**：

```text
Linux 本地目录 / 已挂载的 SMB 或 NFS 共享
  → gdu（开源目录扫描器，已验证 v5.39.0）
  → scripts/efu-scan.mjs（校验、路径前缀映射、EFU 转换、原子发布）
  → 同源 HTTP 发布 /indexes/*.efu 与 config.json（Docker / Nginx）
  → efu-browser 浏览器端解析、搜索、排序、分页与主题切换
```

同时**完整保留 GitHub Pages 纯静态部署与手动导入本地 `.efu` 文件**的原有用法。EFU 是组件之间的标准接口：Windows 端可继续使用 Everything 或 EFUtool 导出 `.efu`，直接导入网页或放入受保护的索引目录。

---

## 核心特性

- **零构建静态前端**：原生 HTML / CSS / JS，兼容根路径与 GitHub Pages 子路径部署。
- **可选服务器索引（`config.json`）**：无需重新打包前端即可声明一个或多个同源 `.efu` 快照，支持切换、重新加载、HTTP `Last-Modified` 快照修改时间展示、失败保留旧结果与快速切换防竞态。默认空配置不请求任何 `.efu` 文件、不报错。
- **Linux/NAS 扫描到 EFU 适配层（`scripts/efu-scan.mjs`）**：
  - 复用 `gdu`（已验证 `v5.39.0`）保留表观文件大小（`Size`）与修改时间（`Date Modified`，Windows FILETIME）。
  - 严格校验退出码、stderr、`gdu` 日志与 JSON `read_error` 标记，拒绝把权限错误或截断输出当成完整快照发布。
  - 支持目录剪枝排除（`--exclude`）、基于 `/proc/self/mountinfo` 的真实挂载点双重校验（`--require-mount`）、边界安全的导出路径前缀改写（`--export-prefix`），以及同目录临时文件 + `rename` 原子发布。
- **主题与界面**：提供明亮、暗黑（参考 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 中性深色体系）与 macOS 三套主题，支持模糊/通配符/正则搜索、`file:`/`path:`/`!` 语法、列显示控制与双击复制路径。

---

## 最短自托管步骤（从扫描 `/mnt/nas/projects` 到网页搜索）

### 1. 安装已验证的扫描器 `gdu`（v5.39.0+）与 Node.js（>= 20）

```bash
# 下载官方静态二进制（Linux x86_64，已验证版本 v5.39.0）
curl -fsSL https://github.com/dundee/gdu/releases/download/v5.39.0/gdu_linux_amd64_static.tgz \
  | tar -xz -C /tmp
sudo install -m 0755 /tmp/gdu_linux_amd64_static /usr/local/bin/gdu
gdu --version
```

> 说明：`gdu v5.39.0` 起在 JSON 导出中原生输出 `"read_error": true` 标记不可读目录；适配层同时校验 `gdu` 日志文件、退出码与 JSON 结构，确保部分扫描不会被静默覆盖为正式快照。

### 2. 扫描 `/mnt/nas/projects` 并原子发布 EFU 快照

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

### 3. 配置运行时服务器索引（无需重新构建前端）

复制示例配置 `deploy/config.example.json` 为 `config.json`（或挂载到容器内 `/usr/share/nginx/html/config.json`）：

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

- `url` 支持相对路径（兼容子路径部署）或同源绝对路径（如 `/indexes/projects.efu`），前端会拒绝跨域或非 `http(s)` 地址。

### 4. 同源启动 Web 服务（复用 Docker / Nginx）

```bash
# 使用 docker-compose.env.yml 只读挂载 ./indexes 与 ./config.json
EFU_INDEX_DIR=./indexes EFU_CONFIG_FILE=./deploy/config.example.json \
  docker compose -f docker-compose.env.yml up -d --build
```

浏览器访问 <http://localhost:8080>，即可自动载入 `NAS 项目目录` 并搜索其中的文件。

> 权限隔离原则：**Web 容器仅只读挂载 `./indexes:/app/indexes:ro` 与 `config.json:ro`，绝不挂载原始 NAS 目录 `/mnt/nas/projects`**；`docker/nginx.conf` 已关闭目录列表（`autoindex off`），仅放行 `.efu` 文件并设置 `Cache-Control: no-cache`。

---

## 定时扫描调度示例

扫描任务由系统定时调度运行，不通过 Web 进程触发。

### 方式 A：systemd timer（推荐）

仓库内置了最小权限模板 [`deploy/efu-scan.service`](deploy/efu-scan.service) 与 [`deploy/efu-scan.timer`](deploy/efu-scan.timer)：

- 使用专用低权限账号 `efu-scanner` 运行。
- `ReadOnlyPaths=/mnt/nas/projects` 限制扫描进程对 NAS 源目录只读。
- `ReadWritePaths=/srv/efu-browser/indexes` 仅允许写入生成的索引目录。

```bash
sudo cp deploy/efu-scan.service deploy/efu-scan.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now efu-scan.timer
# 手动触发一次验证
sudo systemctl start efu-scan.service
journalctl -u efu-scan.service -n 20 --no-pager
```

### 方式 B：cron

以只读访问 NAS、可写索引目录的低权限用户编辑 crontab：

```cron
0 3 * * * /usr/bin/node /opt/efu-browser/scripts/efu-scan.mjs --root /mnt/nas/projects --output /srv/efu-browser/indexes/projects.efu --exclude .snapshot --exclude @eaDir --require-mount /mnt/nas --export-prefix '\\nas\projects' >> /var/log/efu-scan.log 2>&1
```

---

## `efu-scan.mjs` CLI 说明与边界

| 参数 | 说明 |
| --- | --- |
| `--root <dir>` | 必需。扫描根目录。 |
| `--output <file>` | 必需。目标 `.efu` 路径；临时文件创建在目标同目录，校验通过后 `fsync` + `rename` 原子替换。 |
| `--exclude <pattern>` | 可重复。**不含 `/`** 时按目录名匹配任意层级（如 `.snapshot`、`@eaDir`）；**含 `/`** 时按相对 `--root` 的目录路径匹配（如 `sub/cache`）。匹配到的目录会在 `gdu` 遍历阶段**整棵剪枝跳过**，不会进入读取其内容。 |
| `--require-mount <path>` | 可选。通过读取 `/proc/self/mountinfo` 校验指定路径确实处于已挂载状态，且 `--root` 等于或位于该挂载点之下（非“目录存在/非空”判断）。在**扫描前与发布前**各检查一次。注意：该检查用于防范未挂载或发布前卸载，但不能保证覆盖所有中途网络瞬断或陈旧 NFS 句柄（扫描过程中的读取错误由 `gdu` 的 `read_error` 与日志检查拦截）。 |
| `--export-prefix <prefix>` | 可选。仅重写导出 EFU 中的 `Filename` 前缀（如 `\\nas\projects`），按目录边界拼接相对路径，不改变实际扫描目录。 |
| `--gdu-bin <path>` | 可选。指定 `gdu` 可执行文件路径（默认读取 `EFU_GDU_BIN` 或 `PATH`）。 |

### 输出格式、目录与内存说明

- **输出列**：`Filename,Size,Date Modified`（UTF-8，RFC 4180 CSV 转义，支持空格、中文、逗号、双引号与文件名内换行；`Size` 为表观字节数，空文件为 `0`，符号链接等非普通文件不跟随且不编造大小；`Date Modified` 为 Windows FILETIME，不以 Linux `ctime` 冒充 `Date Created`）。
- **空目录行为**：`gdu` 后端仅输出文件条目（不输出独立目录行），因此**空目录不会单独出现在列表中**（若扫描根目录本身为空，仍合法生成仅含表头的 EFU）。
- **内存占用说明**：`gdu` 会先将完整目录树载入内存再序列化 JSON，适配层也会解析 JSON 树后写出 EFU，因此**整条链路峰值内存与总条目数呈线性关系 `O(N)`，而非恒定内存**。

---

## 在线演示（Scans 页面）与真实 CLI 扫描的区别

顶部导航提供 **Browser**（默认入口）与 **Scans**（`#/scans`，兼容 GitHub Pages `/efu-browser/#/scans` 子路径直达与刷新）：

- 在 GitHub Pages 上，**Scans 页面运行在纯前端演示模式**：明确标注「演示模式：这是模拟扫描，不会访问你的设备、服务器或 NAS。」
- 预置完全虚构的 `Example NAS` 任务与两份小型静态快照：`demo/demo-before.efu`（5 条）与 `demo/demo-after.efu`（6 条，新增 `demo-slide-003.svs`）。
- 点击「立即扫描」会模拟 `等待 → 扫描中 → 完成`（运行期间禁用重复点击），完成后不会自动覆盖 Browser 中已打开的索引；只有点击「打开结果」才会切回 Browser，复用现有 EFU 加载、解析与搜索逻辑打开 `demo-after.efu`。

| 维度 | Scans 页面（演示模式） | 真实 CLI 扫描（`scripts/efu-scan.mjs`） |
| --- | --- | --- |
| 运行位置 | 纯浏览器内存状态机（`scans-demo-service.js`） | Linux 主机 / 容器定时任务（`cron` 或 `systemd timer`） |
| 访问文件系统 / NAS | **不访问**任何本机、服务器或 NAS | 通过 `gdu` 只读遍历指定 `--root` 目录元数据 |
| 数据来源 | 随站点发布的完全虚构静态文件（`demo/demo-*.efu`） | 实际扫描结果并原子发布为 `/indexes/*.efu` |
| 后端依赖 | 无需后端、登录或扫描 API | 依赖主机安装 `gdu` 与 Node.js，Web 端仅同源只读加载 EFU |

---

## GitHub Pages 纯静态部署与 Windows EFU 兼容

- **GitHub Pages / 纯静态使用**：仓库默认 `config.json` 为 `{"indexes": []}`，部署后在 Browser 页面不发任何 `.efu` 请求，直接点击“数据源”或空状态卡片打开本地 `.efu` 文件即可浏览；也可通过顶部 **Scans** 体验交互式模拟扫描演示。
- **Windows / macOS 生成 EFU**：在 Windows 上可直接用 Everything（`文件 -> 导出 -> EFU`）或官方 `EFUtool` 生成 `.efu`，既可本地打开，也可同步到自托管服务器的 `/indexes/` 目录中并通过 `config.json` 引用。

---

## 安全与快照边界（重要）

1. **快照而非实时文件系统**：网页搜索的是**最近一次成功发布的 EFU 快照**；若某次扫描失败，原子发布保护会保留上一份可用快照。
2. **元数据泄露边界**：**任何能够下载某份 `.efu` 文件的用户都可以读取其中包含的全部文件名与路径**。多人共用场景请按权限边界拆分为多份 `.efu`，并在 HTTP / 反向代理层（如 Nginx Basic Auth / Authelia / Authentik / Tailscale）同时保护 `config.json` 与 `/indexes/*.efu`，**绝不能依靠前端筛选实现访问控制**。
3. **切勿泄露私人快照**：不要把私人 NAS 的 `.efu` 快照提交到 Git 仓库（`.gitignore` 已默认忽略 `*.efu` 与 `indexes/`），也不要发布到公开的 GitHub Pages。

---

## 开发与测试

要求 Node.js >= 20（零外部 npm 依赖），测试完整 E2E 需安装 `gdu`（推荐 `v5.39.0`）和 Chromium：

```bash
npm run lint
npm test
```

## 开源协议

MIT License。

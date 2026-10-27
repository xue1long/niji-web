# niji-web

在 Midjourney 镜像站（niji・journey）生图，并管理其生图设置。面向 WorkBuddy / Claude Code 等带浏览器控制能力的 AI 编码助手。

## 能力

- 提交生图任务，轮询状态，并发下载原图（webp），批量转 JPG 供聊天窗口内联展示
- 读取 / 修改站点生图设置（宽高比、风格化、怪异度、多样性、raw、draft、版本、速度）
- 站点域名、账号 ID、CDN 地址全部自动探测，不硬编码 —— 换镜像站、换账号都能用

## 安装

把 `niji-web/` 整个目录放到技能目录下：

```
~/.workbuddy/skills/niji-web/        # 用户级（推荐）
<项目>/.workbuddy/skills/niji-web/    # 项目级
```

## 首次配置

1. 在浏览器打开目标镜像站的 `/imagine` 页，确认已登录

   镜像站地址形如 `https://nijijourney-<站点标识>.d.aiwentu.net`（站点标识是租户后缀，各人不同，从你自己的浏览器地址栏取）

2. 让 AI 执行 `scripts/discover.js`（通过浏览器控制通道注入页面执行），拿到 JSON

3. 生成配置：

   ```bash
   node scripts/init-config.mjs --from <discover输出.json>
   ```

   配置写入技能目录的**同级父目录**（如 `~/.workbuddy/skills/niji-web.config.json`），
   **含会话 Cookie，属敏感信息**。放在技能目录之外，避免被误打包进分发 zip。

   也可用环境变量代替配置文件：`NIJI_HOST` / `NIJI_USER_ID` / `NIJI_CDN` / `NIJI_COOKIE`，
   或 `NIJI_CONFIG` 指定配置文件路径。

## 使用

生图：

```bash
node scripts/niji-gen.mjs "你的提示词" --ar 16:9 --v 8.2 --stylize 150 --weird 4 --out ./outputs --name pic
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--ar` | 16:9 | 宽高比，如 1:1 / 4:3 / 7:3 / 21:9 |
| `--v` | 配置值 | 版本，如 8.2 / 7 / 6.1 |
| `--stylize` | 150 | 风格化强度 |
| `--weird` | 4 | 怪异度 |
| `--chaos` | 0 | 多样性 |
| `--raw` | — | 字面模式 |
| `--relax` | — | 慢速模式（默认 fast） |
| `--private` | — | 不公开到画廊 |
| `--out` | ./outputs | 输出目录 |
| `--name` | niji | 文件名前缀 |
| `--no-jpg` | — | 只留 webp 原图，不转 JPG |
| `--max-w` | 1400 | JPG 最大边 |

改设置：

```bash
node scripts/niji-settings.mjs show
node scripts/niji-settings.mjs set ar=4:3 stylize=250 weird=0 raw=false
node scripts/niji-settings.mjs reset
```

> 设置存于浏览器 localStorage，改完**必须刷新页面**。
> 该命令需要 Chrome 以 `--remote-debugging-port=9222` 启动；不便启动时让 AI 用浏览器控制通道直接读写 localStorage。

## 依赖

- Node.js 22+（需内置 `WebSocket` 与 `fetch`）
- Python + Pillow —— 仅用于转 JPG。缺失时脚本自动跳过，webp 原图仍正常产出。
  用 `NIJI_PYTHON` 指定解释器路径；脚本也会自动找 PATH 上的 `python`/`python3`

## 安全须知

- `niji-web.config.json` 与 `niji-web.cookie.txt` 含会话 Cookie —— **不要提交仓库、不要外传**
- Cookie 会过期（表现为 401），重新执行首次配置即可刷新
- 每次生图都会在用户画廊留下记录。清理测试任务请用站点 UI 的 Trash 按钮

## 文档

- `references/api.md` —— API 契约、合法 prompt flag 全集、性能实测
- `references/settings.md` —— 设置字段与 prompt 参数映射、localStorage 结构
- `references/troubleshooting.md` —— 踩坑清单与诊断顺序

---
name: niji-web
description: 在 Midjourney 镜像站（niji・journey，如 nijijourney-*.d.aiwentu.net）生图并把结果返回到聊天窗口，同时支持读取/修改该站的生图设置（宽高比、风格化、怪异度、多样性、raw、版本等）。触发词：niji、nijijourney、midjourney 镜像、生图、生成图片、出图、改生图设置、设置面板。
agent_created: true
---

# niji-web

在 Midjourney 镜像站生图，并管理其生图设置。

站点是 tanpopo 托管平台上的 Midjourney 镜像（nijijourney.d.com 系列）。**每个镜像站的域名、账号 ID、CDN 地址都不同**，因此全部从配置读取，不得硬编码。

## 工作流程

### 1. 确认配置

检查 `<skill_dir>/../niji-web.config.json` 是否存在。不存在则执行首次配置（见下）。

### 2. 首次配置（一次性）

在浏览器打开目标镜像站的 `/imagine` 页并确认已登录，然后执行 `scripts/discover.js`（内容注入浏览器页面）：

```js
// 用 chrome-devtools MCP 的 evaluate_script 执行 scripts/discover.js
// 该脚本从 performance entries / localStorage / img src 中提取:
//   site, host, userId, channelId, cdn, cookie, service, version
```

把输出写入配置：

```bash
node scripts/init-config.mjs --from <discover输出.json>
# 或显式传参
node scripts/init-config.mjs --host <域名> --cdn <CDN前缀> --user-id <uuid> --cookie "<cookie串>"
```

配置落在技能目录的**同级父目录**（如 `~/.workbuddy/skills/niji-web.config.json`），含 Cookie —— **属敏感信息，不要提交到仓库或外传**。
放在技能目录之外，避免被误打包进分发 zip。

### 3. 生图

```bash
node <skill_dir>/scripts/niji-gen.mjs "提示词" \
  --ar 16:9 --v 8.2 --stylize 150 --weird 4 --chaos 0 \
  --out <输出目录> --name <文件前缀>
```

常用参数：`--ar` `--v` `--stylize` `--weird` `--chaos` `--raw` `--relax` `--private` `--out` `--name` `--no-jpg` `--max-w`

stdout 输出 JSON：`job_id` / `prompt` / `width` / `height` / `status` / `timings_ms` / `images[]`（含 `file`、`jpg`、`cdnUrl`、`bytes`）

### 4. 返回结果到聊天窗口

1. `show_widget` 内联渲染 `<img src="绝对路径.jpg">`，用宿主 CSS 变量适配浅色主题
   - **用 JPG（100–200KB），不要用 PNG（全分辨率约 1.5MB/张）**
   - 浏览器原生支持 webp，但体积更大，仅在需要原图时用
2. `present_files` 附上 JPG 与原图 webp 供下载

### 5. 修改生图设置（可选）

设置存于浏览器 localStorage 的 `settings_v30`，改完**必须刷新页面**让 React 重读。

```bash
node <skill_dir>/scripts/niji-settings.mjs show
node <skill_dir>/scripts/niji-settings.mjs set ar=4:3 stylize=250 weird=0 raw=false
node <skill_dir>/scripts/niji-settings.mjs reset
```

需浏览器以 `--remote-debugging-port=9222` 启动。若不便启动，改用 chrome-devtools MCP 的 `evaluate_script` 直接读写 localStorage（见 `references/settings.md`）。

## 重要约束

- **不得硬编码站点域名、账号 ID、CDN 地址** —— 每用户不同，一律走配置
- **不得在未获明确指示时批量生图** —— 站点是用户的第三方服务账号，每次生图都进用户画廊
- **Cookie 不得外传或提交仓库**
- Cookie 会过期（表现为 401），需重新执行第 2 步刷新配置

## 参考资料

需要时按需读取：

- `references/api.md` —— API 契约完整说明（端点、请求体、响应结构、合法 flag 全集）
- `references/settings.md` —— 设置面板字段与 prompt 参数的映射关系、localStorage 结构
- `references/troubleshooting.md` —— 踩坑清单与诊断路径

---
name: niji-web
description: 在 Midjourney 镜像站（niji・journey，如 nijijourney-*.d.aiwentu.net）生图并把结果返回到聊天窗口；支持图生文（describe，反推提示词）、出图后处理（vary/reroll/remix/zoom/pan/ar 扩图等），以及读取/修改该站的生图设置（宽高比、风格化、怪异度、多样性、raw、版本等）。触发词：niji、nijijourney、midjourney 镜像、生图、生成图片、出图、图生文、反推提示词、改生图设置、设置面板、放大、变体、扩图、平移、重混、zoom、pan、vary、remix。
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

### 3.5 图生文（describe）— 反推提示词

上传一张图（本地文件或图片 URL），站点返回 Midjourney 生成的 4 条提示词。适合「看到喜欢的图、想复刻其 prompt」的场景。

```bash
# 本地图片
node <skill_dir>/scripts/niji-describe.mjs "/path/to/ref.png" --out <输出目录> --name ref
# 图片 URL（站内 CDN 直用，外链先转存）
node <skill_dir>/scripts/niji-describe.mjs "https://cdn-xxx/foo.webp"
# 仅输出 JSON（供程序解析）
node <skill_dir>/scripts/niji-describe.mjs "ref.png" --json
```

参数：`--config` `--out`（把 4 条写成 `<name>.json`） `--name`（默认 describe） `--json`

- 本地图经 `/api/storage-upload-file`（multipart）上传，URL 经 `/api/storage-upload-link` 转存；最终都交给 `/api/describe { image_url }`
- 返回结构兼容 `{ data: { descriptions: [...] } }` 与 `{ descriptions: [...] }`
- 消耗站点「查询」配额（非生图配额）；401 表示 Cookie 过期，需重跑首次配置

### 3.8 出图后处理（niji-act）— 在已生成的 grid 上二次操作

```bash
# 变体（微弱 / 强变体）
node <skill_dir>/scripts/niji-act.mjs vary   --job <job_id> --index 0 [--strong|--subtle]
# 重跑（reroll）
node <skill_dir>/scripts/niji-act.mjs reroll --job <job_id> [--prompt "..."]
# 改提示词重混
node <skill_dir>/scripts/niji-act.mjs remix  --job <job_id> --index 0 --prompt "..." [--strong|--subtle]
# 缩小扩图（补出周边环境），factor 默认 2
node <skill_dir>/scripts/niji-act.mjs zoom   --job <job_id> --index 0 [--factor 2] [--prompt "..."]
# 平移扩图
node <skill_dir>/scripts/niji-act.mjs pan    --job <job_id> --index 0 --dir up|down|left|right [--prompt "..."]
# 改宽高比
node <skill_dir>/scripts/niji-act.mjs ar     --job <job_id> --index 0 --ar 16:9 [--prompt "..."]
```

通用选项：`--relax` `--private` `--out` `--name` `--no-jpg` `--max-w` `--config`

要点：

- `--job` 是**源 grid 的任务 id**（即 `niji-gen.mjs` 输出的 `job_id`）；`--index` 是 grid 内 0–3 的序号（U1=0, U2=1, U3=2, U4=3）
- zoom / pan / ar 省略 `--prompt` 时，自动拉取父 grid 的 `full_command` 作为 newPrompt
- 输出 JSON 与 `niji-gen.mjs` 一致（含 `job_id` / `images[]` / `timings_ms`），同样自动转 JPG
- **U1–U4 放大（upscale）不可用** —— 属镜像站服务端缺陷，见下方「已知功能边界」

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

## 已知功能边界（镜像站限制）

该镜像站基于 Midjourney Web，但并非官方全部功能都对等开放。经**前端代码逆向 + 服务端实测**核实（标注 ✅ 的均已真实提交并成功返回 job_id）：

| 功能 | 状态 | 说明 |
|---|---|---|
| 文生图 imagine | ✅ 脚本已覆盖 | `niji-gen.mjs` |
| 图生文 describe | ✅ 脚本已覆盖 | `niji-describe.mjs`（反推 4 条提示词） |
| 设置读写 | ✅ 脚本已覆盖 | `niji-settings.mjs` |
| explore / 发现页 | ➖ 仅站点手动 | 路由存在，无自动化脚本 |
| Vary（Subtle / Strong 变体） | ✅ 已覆盖并端到端实测 | `niji-act.mjs vary`；已实测提交→出图→下载→转 JPG 全链路 |
| Reroll 重跑 | ✅ 已覆盖 | `niji-act.mjs reroll` |
| Remix 改词重混 | ✅ 已覆盖 | `niji-act.mjs remix`（必填 `--prompt`） |
| Zoom Out 缩小扩图 | ✅ 已覆盖 | `niji-act.mjs zoom` |
| Pan 上下左右平移 | ✅ 已覆盖 | `niji-act.mjs pan` |
| AR 宽高比变更 | ✅ 已覆盖 | `niji-act.mjs ar` |
| **U1–U4 放大 upscale** | ❌ 不可用（站点服务端缺陷） | `niji-act.mjs upscale` 会给出原因说明。实测：官方载荷 `t=upscale+type=v8_virtual` → `Unknown submit type`；改用 `type=upscale` 并通过校验后，服务端抛 `prompt.replaceAll is not a function`（同一字段既要求对象又要求字符串）。`prompt` 以字符串/对象/嵌套对象/同级字段共 20+ 种组合提交均复现，**非载荷问题，无法从请求端绕过**。替代：网页端手动点 U1–U4，或用 zoom/pan 出单张大图 |
| 局部重绘 repaint | ⚠️ 实验性，未验证 | `niji-act.mjs repaint` 已按前端载荷实现（需 `--mask` 遮罩 PNG），但镜像站未实测通过 |
| Shorten 提示词精简 | ❌ 未开放 | 该站**无 `/api/shorten` 端点**（已枚举确认） |
| **多图融合 blend** | ❌ 未开放 | 前端 `type` 枚举中**无 `blend`**，所有 "blend" 命中均为帮助文案；`/blend` 路由虽返回 200 但无提交逻辑，故无自动化脚本 |
| 标准 MJ 写实（--v 8.2 --raw） | ✅ 可用 | 该账号同时带标准 MJ 模型，走 `--v 8.2 --raw` 出照片级图 |

> 如需「多图融合」效果，可退而用 imagine 的**多图参考**（`imagePrompts` 数组）近似：把多张图上传后作为参考图提交 imagine。但这属于「带参考的生图」而非严格等权 blend，不保证构图融合，需用户确认是否要加此近似脚本。

## 参考资料

需要时按需读取：

- `references/api.md` —— API 契约完整说明（端点、请求体、响应结构、合法 flag 全集）
- `references/settings.md` —— 设置面板字段与 prompt 参数的映射关系、localStorage 结构
- `references/troubleshooting.md` —— 踩坑清单与诊断路径

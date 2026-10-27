# API 契约

以下均已实测验证。所有端点都在站点自身域下（`https://{host}`）。

## 通用请求头

```
Cookie: <会话 cookie>
Content-Type: application/json
X-CSRF-Protection: 1
Origin: https://{host}
Referer: https://{host}/imagine
```

**`X-CSRF-Protection: 1` 是必需的** —— 缺失时 `/api/imagine` 返回 401 `{"error":"Unauthorized"}`。

## 提交生图

`POST /api/submit-jobs`

请求体：

```json
{
  "f": { "mode": "fast", "private": false },
  "channelId": "singleplayer_{userId}",
  "metadata": {
    "isMobile": null, "imagePrompts": 0, "imageReferences": 0,
    "characterReferences": 0, "depthReferences": 0, "lightboxOpen": null
  },
  "t": "imagine",
  "prompt": "提示词 --ar 16:9 --raw --stylize 150 --weird 4 --v 8.2"
}
```

响应：

```json
{ "success": [ { "job_id": "uuid", "prompt": "...", "is_queued": false,
                 "event_type": "diffusion", "job_type": "v8-2_diffusion",
                 "flags": { "mode": "fast", "visibility": "public" },
                 "meta": { "height": 816, "width": 1456, "batch_size": 4 } } ],
  "failure": [] }
```

站点会把参数写进 `prompt` 字段回显（如追加 `--niji 7`），这是服务端行为，不影响客户端。

## 查询任务状态

`POST /api/job-status`

```json
{ "jobIds": ["uuid"], "_frontend_source": "useJobSubmitter_fetchJobStatus" }
```

响应为数组：

```json
[ { "id": "uuid", "current_status": "completed",
    "full_command": "...", "width": 1456, "height": 816,
    "batch_size": 4, "job_type": "v8-2_diffusion",
    "enqueue_time": "2026-10-27 09:23:30.367314+00:00" } ]
```

`current_status` 取值：`completed` / `failed` / `error` / 其他进行中状态。

**响应不含图片 URL** —— 图片路径由 `job_id` 推导，见下。

## 任务历史

`GET /api/imagine?user_id={userId}&page_size=N`

响应：

```json
{ "data": [ { "id": "uuid", "full_command": "...", "user_hidden": false,
               "published": true, "image_likes": [], "width": 1456, "height": 816 } ] }
```

用于列出历史任务、判断任务是否还在画廊。

## 用户可变状态

`GET /api/user-mutable-state` → `{ "settings": { "speed": "fast", "visibility": "public" }, "macros": {}, "flags": [...] }`

**服务端只同步 `speed` 与 `visibility` 两项**，其余生图参数全在浏览器 localStorage。

`GET /api/user-gen_settings` → 同上，仅 `{ speed, visibility }`

## 图片获取

图片在 CDN 上，**免鉴权**（无需 Cookie，甚至无需 Referer）：

```
{cdn}/{jobId}/0_{index}.webp          ← 原图，全分辨率（如 1456×816）
{cdn}/{jobId}/0_{index}_640_N.webp    ← 缩略图
{cdn}/{jobId}/0_{index}_1024_N.webp   ← 中图
{cdn}/{jobId}/0_{index}_2048_N.webp   ← 大图
```

CDN 为 Cloudflare，`accept-ranges: bytes`（支持 Range），`cache-control: public, max-age=31449600`。

`index` 范围 `0 .. batch_size-1`。

## 其他端点（供参考）

| 端点 | 用途 | 备注 |
|---|---|---|
| `/api/job-cancel` | 取消排队中的任务 | POST `{job_id}` |
| `/api/job-like?id=&value=&gridIndex=` | 点赞 | POST |
| `/api/rate-image` | 评分 / **用户删除任务**（`value:1, sr:true`） | POST `{value, jobId, gridIndex, sr}` |
| `/api/update-jobs` | 批量改任务 | PUT `{task, value, jobIds}`；`mod_hidden` 为版主专用（400） |
| `/api/websocket-token` | WebSocket token | 实时推送未验证 |
| `/api/signed-cdn-urls` | 批量签名下载 | **此镜像站返回 400，未开放** |
| `/api/v2/*` | Datadog 日志上报 | 与业务无关 |

## prompt 合法 flag 全集

站点解析器接受的参数（超出范围会报 `promptParser.unknownFlag`）：

```
width height seed sameseed stop iw zoom weird w raw draft preview exp
motion length end style no hd sd video test testp creative tile niji
sref sw sv personalize personalise personalization profile p pv cref cw
dref dw oref ow stylize stylise s chaos c quality q version v aspect ar
uplight upbeta upanime fast relax turbo stealth public bs av default
```

参数校验规则：

| flag | 约束 | 错误信息 |
|---|---|---|
| `--chaos` / `--c` | 0–100 | `promptParser.chaosOutOfRange` |
| `--stop` | 10–100 | `promptParser.stopOutOfRange` |
| `--q` / `--quality` | 0.25–5 | `promptParser.qualityInvalid` |
| `--ar` | `W:H` 格式 | `promptParser.aspectRatioInvalid` |
| `--bs` | 数字 | `promptParser.batchSizeInvalid` |
| `--version` / `--v` | 无参数 | `promptParser.versionFlagHasArgs` |

## 提交体字段与 prompt 参数的分工

| 字段 | 影响 |
|---|---|
| `prompt` 里的 `--xxx` | 大部分参数（ar / stylize / weird / chaos / raw / draft / v / bs ...） |
| `f.mode` | `fast` / `relax` —— **不进 prompt**，是独立的服务端调度档位 |
| `f.private` | 是否公开到画廊 |
| `t` | 任务类型，`imagine` 为生图 |

## 性能实测（fast 模式）

| 阶段 | 耗时 | 备注 |
|---|---|---|
| 提交 | ~1.2s | 首次含 TLS 握手 |
| 等待出图 | 5–40s | **服务端出图时间，不可压缩** |
| 下载 4 张（并发） | 1.9–2.7s | 串行需 6.9s |
| 转 JPG（常驻 worker） | 0.5s | 冷启动与出图等待重叠时 |

并发度扫描：c1=6935ms / c2=3082 / c4=2114 / c8=1778 —— **取 4**。

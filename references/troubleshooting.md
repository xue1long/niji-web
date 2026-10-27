# 踩坑清单与诊断

## 症状 → 根因 → 解法

| 症状 | 根因 | 解法 |
|---|---|---|
| 直接 GET 站点返回 401「登录已失效」 | 该站需会话 Cookie，无 Cookie 时返回托管平台的自定义 401 页 | 用 CLI 带 Cookie 请求，或在浏览器内操作 |
| CLI 报「配置缺失: host, cookie」 | 未生成配置文件 | 运行 `scripts/discover.js` + `scripts/init-config.mjs` |
| CLI 报「提交失败: ...」且状态 401 | Cookie 过期 | 重新执行 discover + init-config 刷新配置 |
| `/api/imagine` 返回 401 Unauthorized | 缺 `X-CSRF-Protection: 1` 头 | 加上该头 |
| 点击页面按钮「没反应」 | 点的是 Settings 开关 | 提交按钮图标 id 是 **`PaperAirplane`**，且**提示词为空时按钮不存在**，填完词才出现 |
| fetch 拦截器抓不到 submit-jobs | 拦截器装在了别的 page，或页面 reload 后失效 | 装在同一 page；reload 后需重装 |
| React 合成事件不触发 | 只派发了 `click` | 需完整序列：`pointerdown→mousedown→pointerup→mouseup→click` |
| `update-jobs` 的 `mod_hidden` 返回 400 | 那是版主专用接口 | 用户删除走 UI 的 **Trash** 按钮（整组级，文本恰为 "Trash"，**不要选 "Trash image"**） |
| 抓到 `/api/v2/` 请求 | 那是 Datadog 日志上报 | 与业务无关，忽略 |
| 误判「设置被覆盖」 | 抓到的是历史任务卡片的参数徽章 | 见 `settings.md` 的面板判据 |
| 提交后没有 JPG | 找不到带 Pillow 的 Python | 装 Pillow，或用 `--no-jpg` 只留 webp |
| Python worker 卡住 | 系统上 `python` 指向无 Pillow 的解释器 | 设 `NIJI_PYTHON` 环境变量指定解释器路径 |
| `niji-settings.mjs` 找不到浏览器页面 | Chrome 未开调试端口 | 用 `--remote-debugging-port=9222` 启动；或改走 MCP `evaluate_script` |
| 脚本写文件后文件不存在 | 部分环境的文件写入对深层新目录会「报成功但未落盘」 | 写入后**必须回查**（`fs.existsSync` / 目录列举），失败则改用 `fs.writeFileSync` |

## 删除任务（清理测试/探针产物）

生图会在用户画廊留下记录（`published: true`）。

**UI 方式**（可靠）：

1. 在站点 `/imagine` 页找到目标任务卡片
2. 点整组级的 **"Trash"** 按钮（不是每张图的 "Trash image"）
3. 任务从 `/api/imagine` 列表消失，`image_likes` 不受影响

底层实际调用是 `POST /api/rate-image`，body `{value:1, jobId, gridIndex, sr:true}` —— 是评分接口兼做隐藏，不是真删除。

## 诊断顺序

1. **配置对不对** → 读 `niji-web.config.json`，确认 `host` 与 `cookie` 非空
2. **Cookie 有效吗** → `GET /api/imagine?user_id=...&page_size=1` 带 `X-CSRF-Protection: 1`，看是否 200
3. **能提交吗** → `POST /api/submit-jobs` 带完整 body，看是否返回 `success[].job_id`
4. **能取图吗** → 直接 `GET {cdn}/{jobId}/0_0.webp`（免鉴权），返回 200 即说明 CDN 路径推导正确

## 环境事实

- Node 的 `https` 模块**默认不走代理**，即使设置了 `HTTP_PROXY` / `HTTPS_PROXY`。若需走代理，用 `https-proxy-agent` 或让站点直连。
- `reg.exe` 在部分环境被安全策略拉黑，读注册表用 PowerShell 的 `Get-ItemProperty` 代替。
- Windows 上 `Remove-Item` 对绝对路径可能静默失败，删除临时文件用 Node 的 `fs.rmSync(path, {force:true})` 并回查。

## Python 环境

JPG 转换需要 Pillow：

```bash
python -m venv .venv
.venv/Scripts/pip install Pillow
```

然后设 `NIJI_PYTHON` 指向该解释器。脚本会依次尝试：`NIJI_PYTHON` → `python`/`python3`/`py`（PATH）→
`~/.workbuddy/binaries/python/envs/default/`（Windows 与 Unix 两种路径）。

若始终找不到，脚本会静默跳过 JPG（webp 原图仍正常产出），用 `--no-jpg` 可显式关闭。

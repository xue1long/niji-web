# 生图设置面板

设置全部存于**浏览器 localStorage 的 `settings_v30`** 键。服务端只同步 `speed` 与 `visibility`，其余纯本地。

## localStorage 结构

```json
{
  "version": "8.2",
  "styleCreatorVersion": "niji 7",
  "videoVersion": "1",
  "universal": { "chaos": 0, "ar": { "w": 16, "h": 9 } },
  "versions": {
    "8.2": { "styleRaw": true, "stylize": 150, "weird": 4, "draft": false, "hd": false },
    "8.1": { "styleRaw": true, "stylize": 100, "weird": 0, "draft": false, "hd": false },
    "7":   { "styleRaw": true, "stylize": 100, "weird": 0, "draft": false },
    "niji 7": { "styleRaw": true, "stylize": 100, "weird": 0, "draft": false }
  },
  "videoVersions": { "1": { "resolution": "480p", "motion": "low", "length": 5, "batchSize": 4 } },
  "speed": "fast",
  "service": "niji",
  "saveReason": "saveFlags",
  "darkMode": "system",
  "imageStrengths": { "imagePrompt": 1, "styleReference": 100, "characterReference": 100, "omniReference": 100 },
  "toolbarVisible": { "rerun": true, "video": true, "vary": true, "upscale": true, "use": true }
}
```

`versions` 下每个版本各有一份默认值；`version` 指向当前生效的那份。

## 字段 → prompt 参数映射（实测）

| localStorage 路径 | prompt 参数 | 备注 |
|---|---|---|
| `universal.ar` | `--ar W:H` | `{w:16,h:9}` → `16:9` |
| `universal.chaos` | `--chaos N` | 0 时省略 |
| `versions[v].stylize` | `--stylize N` | 0 时省略 |
| `versions[v].weird` | `--weird N` | 0 时省略 |
| `versions[v].styleRaw` | `--raw` | false 时参数不出现 |
| `versions[v].draft` | `--draft` | |
| `version` | `--v X` | |
| `speed` | 提交体 `f.mode` | relax/fast，**不进 prompt** |

### 已验证的改法

在页面里改 localStorage → **刷新页面** → React 重读 → UI 徽章与实际 prompt 同步变化。

一次改 5 个字段（stylize 250 / weird 12 / styleRaw false / ar 4:3 / chaos 20）后，
提交体正确变为 `--chaos 20 --ar 4:3 --stylize 250 --weird 12 --v 8.2`，且 `--raw` 因 `styleRaw:false` 正确消失。

## 已知无效的字段

| 字段 | 现象 |
|---|---|
| `versions[v].hd` | **不进 prompt**，设 true 无效果 |
| `batchSize` | 不是合法字段。写入后 prompt 会出现脏值 `--bs 24`（数值被错误拼接） |
| 顶层 `speed` | 不进 prompt，实际生效的是提交体的 `f.mode` |

## 读取当前设置

```js
const s = JSON.parse(localStorage.getItem('settings_v30'));
const v = s.version;
console.log(s.versions[v], s.universal, s.speed);
```

## 修改设置

```js
const s = JSON.parse(localStorage.getItem('settings_v30'));
s.versions[s.version].stylize = 250;
s.versions[s.version].weird = 0;
s.versions[s.version].styleRaw = false;   // 关掉 --raw
s.universal.ar = {w: 4, h: 3};
s.universal.chaos = 20;
s.saveReason = 'saveFlags';                // 标记为用户设置，避免被迁移逻辑覆盖
localStorage.setItem('settings_v30', JSON.stringify(s));
```

改完**必须刷新页面**。

## 读取面板显示值的判据

页面上 `--ar 16:9` / `--stylize 150` 这类徽章**同时出现在设置面板和历史任务卡片**里。
按 `innerText` 抓「面板文本」容易抓到历史卡片，误判成设置被覆盖。

准确判据：面板根元素须同时包含 `Aspect ratio` + `Stylization` + `Version`，且 `innerText.length < 1200`。

## 设置面板的控件布局

面板从顶部 Settings 按钮展开，内容分四组：

| 组 | 控件 |
|---|---|
| Aspect ratio | 宽高比数字输入 + Portrait / Square / Landscape 快捷键 |
| Aesthetics | Stylization、Weirdness、Variety 三个滑块 + Reset |
| Model | Version（Standard / HD / 8.2）、Raw（Standard / Raw）+ Reset |
| More options | Draft Mode、Relax/Fast、SD/HD、批大小 1/2/4、Personalize |

## 版本切换的副作用

切换 `version` 后，UI 读取的 `versions[v]` 随之切换，默认参数不同（如 8.2 是 stylize 150 / weird 4，
而 7 是 stylize 100 / weird 0）。CLI 的 `--v` 直接写在 prompt 里，不受此影响。

## 提交按钮的准确识别

图标 id 是 **`PaperAirplane`**（纸飞机），且**提示词为空时按钮不存在**。
顶栏的 `Settings` 图标（svg g id 为 `Settings`）只是开关，不是提交。

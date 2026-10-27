/**
 * discover.js —— 在站点页面内执行，一次性提取生图所需的全部环境信息
 *
 * 用法（chrome-devtools MCP）:
 *   evaluate_script({ pageId: <id>, sourcePath: "<skill_dir>/scripts/discover.js" })
 *
 * 返回 JSON 字符串，可直接交给 init-config.mjs --from
 */
(() => {
  const out = {
    site: location.origin,
    host: location.host,
    userId: null,
    channelId: null,
    cdn: null,
    cookie: null,
    service: null,
    version: null,
    errors: [],
  };

  // 1. userId：来自任意一次 /api/imagine 请求的 URL
  try {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    for (const u of urls) {
      const m = u.match(/\/api\/imagine\?user_id=([0-9a-f-]{36})/);
      if (m) { out.userId = m[1]; break; }
    }
  } catch (e) { out.errors.push('perf:' + e.message); }

  // 2. userId 兜底：localStorage 里的 personalization rollout key
  if (!out.userId) {
    try {
      for (const k of Object.keys(localStorage)) {
        const m = k.match(/rollout_closed_v3:([0-9a-f-]{36})/);
        if (m) { out.userId = m[1]; break; }
      }
    } catch (e) { out.errors.push('ls:' + e.message); }
  }

  // 3. CDN：来自页面里已渲染的图片 src
  try {
    const imgs = Array.from(document.querySelectorAll('img')).map((i) => i.src);
    for (const s of imgs) {
      const m = s.match(/^(https:\/\/cdn-[^/]+)\//);
      if (m) { out.cdn = m[1]; break; }
    }
  } catch (e) { out.errors.push('img:' + e.message); }

  // 4. channelId
  if (out.userId) out.channelId = 'singleplayer_' + out.userId;

  // 5. 会话 Cookie（供 CLI 直连 API 使用）
  try { out.cookie = document.cookie; } catch (e) { out.errors.push('cookie:' + e.message); }

  // 6. 当前设置：service 与版本
  try {
    const s = JSON.parse(localStorage.getItem('settings_v30') || '{}');
    out.service = s.service || null;
    out.version = s.version || null;
  } catch (e) { out.errors.push('settings:' + e.message); }

  return JSON.stringify(out, null, 2);
})()

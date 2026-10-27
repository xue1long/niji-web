#!/usr/bin/env node
/**
 * niji-settings.mjs — 读取/修改镜像站的生图设置（存于浏览器 localStorage 的 settings_v30）
 *
 * 用法:
 *   node niji-settings.mjs show
 *   node niji-settings.mjs set ar=4:3 stylize=250 weird=0 raw=false
 *   node niji-settings.mjs reset
 *
 * 需要浏览器以 --remote-debugging-port=<port> 启动（默认 9222）。
 * 端口可用 --port 或环境变量 NIJI_CDP_PORT 指定。
 *
 * 可改字段:
 *   ar=W:H       宽高比，如 16:9 / 1:1 / 4:3 / 7:3
 *   stylize=N   风格化强度 (0-1000)
 *   weird=N     怪异度 (0-3000)
 *   chaos=N     多样性 (0-100)
 *   raw=true|false       字面模式
 *   draft=true|false     草稿模式
 *   hd=true|false        HD
 *   version=X   版本，如 8.2 / 7
 *   speed=fast|relax     速度（服务端同步）
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 技能根目录（scripts/ 的上一级）
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
// 配置可能在技能目录内，也可能在技能目录的同级父目录
const CONFIG_CANDIDATES = [
  path.join(SKILL_ROOT, 'niji-web.config.json'),
  path.join(path.resolve(SKILL_ROOT, '..'), 'niji-web.config.json'),
];
const argv = process.argv.slice(2);
const cmd = argv[0] || 'show';

function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

const PORT = arg('--port', process.env.NIJI_CDP_PORT || '9222');
const HOST = '127.0.0.1';
const SITE = (() => {
  for (const p of CONFIG_CANDIDATES) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).host || ''; } catch { /* 试下一个 */ }
  }
  return '';
})();

// ---------- CDP 目标查找 ----------
function listTargets() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/json/list', timeout: 4000 },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const list = JSON.parse(d);
            resolve(list.filter((t) => t.type === 'page'));
          } catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ---------- CDP 执行 JS ----------
async function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 超时')); }, 15000);
    ws.onopen = () => {
      const msgId = ++id;
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === msgId) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.result?.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception?.description || 'JS 执行异常'));
          } else {
            resolve(msg.result?.result?.value);
          }
        }
      };
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });
}

const DEFAULTS = { styleRaw: true, stylize: 150, weird: 4, draft: false, hd: false };

async function pickTarget() {
  const targets = await listTargets();
  if (!targets.length) {
    console.error(`未找到浏览器页面。\n请用 --remote-debugging-port=${PORT} 启动 Chrome，并打开站点生图页。`);
    process.exit(1);
  }
  const matched = SITE ? targets.filter((t) => (t.url || '').includes(SITE)) : [];
  return matched[0] || targets[0];
}

const target = await pickTarget();
const WS = target.webSocketDebuggerUrl;
if (!WS) { console.error('目标页面无 WebSocket 调试地址'); process.exit(1); }

const READ_EXPR = `(() => {
  const s = JSON.parse(localStorage.getItem('settings_v30') || '{}');
  const v = s.version;
  return JSON.stringify({
    version: v,
    active: s.versions?.[v],
    universal: s.universal,
    speed: s.speed,
    service: s.service,
    saveReason: s.saveReason,
  }, null, 2);
})()`;

if (cmd === 'show') {
  const out = await cdpEval(WS, READ_EXPR);
  console.log(out);
  process.exit(0);
}

if (cmd === 'reset') {
  const out = await cdpEval(WS, `(() => {
    const s = JSON.parse(localStorage.getItem('settings_v30'));
    const v = s.version;
    s.versions[v] = ${JSON.stringify(DEFAULTS)};
    s.universal = {chaos: 0, ar: {w:16, h:9}};
    s.saveReason = 'saveFlags';
    localStorage.setItem('settings_v30', JSON.stringify(s));
    return JSON.stringify({version: v, active: s.versions[v], universal: s.universal});
  })()`);
  console.log(out);
  console.log('已重置，请刷新页面使 React 重读。');
  process.exit(0);
}

if (cmd === 'set') {
  const KNOWN = ['ar', 'stylize', 'weird', 'chaos', 'raw', 'draft', 'hd', 'version', 'speed'];
  const patch = {};
  for (const a of argv.slice(1)) {
    if (a.startsWith('--')) continue;
    const idx = a.indexOf('=');
    if (idx === -1) continue;
    patch[a.slice(0, idx)] = a.slice(idx + 1);
  }
  const unknown = Object.keys(patch).filter((k) => !KNOWN.includes(k));
  if (unknown.length) {
    console.error(`未知字段: ${unknown.join(', ')}\n可用: ${KNOWN.join(', ')}`);
    process.exit(1);
  }
  const out = await cdpEval(WS, `(() => {
    const s = JSON.parse(localStorage.getItem('settings_v30'));
    const patch = ${JSON.stringify(patch)};
    const v = s.version;
    const cur = s.versions[v] || (s.versions[v] = {});
    if (patch.ar) { const [w,h] = patch.ar.split(':').map(Number); s.universal.ar = {w, h}; }
    if (patch.stylize !== undefined) cur.stylize = Number(patch.stylize);
    if (patch.weird !== undefined) cur.weird = Number(patch.weird);
    if (patch.raw !== undefined) cur.styleRaw = patch.raw === 'true';
    if (patch.draft !== undefined) cur.draft = patch.draft === 'true';
    if (patch.hd !== undefined) cur.hd = patch.hd === 'true';
    if (patch.version) s.version = patch.version;
    if (patch.speed) s.speed = patch.speed;
    if (patch.chaos !== undefined) s.universal.chaos = Number(patch.chaos);
    s.saveReason = 'saveFlags';
    localStorage.setItem('settings_v30', JSON.stringify(s));
    return JSON.stringify({version: s.version, active: s.versions[s.version], universal: s.universal, speed: s.speed});
  })()`);
  console.log(out);
  console.log('已写入 localStorage，请刷新页面使 React 重读。');
  process.exit(0);
}

console.error(`未知命令: ${cmd}\n可用: show | set | reset`);
process.exit(1);

#!/usr/bin/env node
/**
 * niji-act.mjs — Midjourney 镜像站「出图后处理」CLI（可移植版）
 *
 * 在已生成的 grid 上执行 U1–U4 放大 / Vary / Reroll / Remix / Zoom-Out / Pan / AR 变更 / 局部重绘。
 * 所有操作都复用 niji-gen 的登录态（config.json 的 host/cookie）与下载/转 JPG 逻辑。
 *
 * 底层调用与官方 web 客户端一致：POST /api/submit-jobs，body 用 t 字段区分操作类型。
 *
 * 用法:
 *   node niji-act.mjs upscale --job <job_id> --index <0-3> [--out dir] [--name p]
 *   node niji-act.mjs vary   --job <job_id> --index <i> [--strong|--subtle]
 *   node niji-act.mjs reroll --job <job_id> [--prompt "..."]
 *   node niji-act.mjs remix  --job <job_id> --index <i> --prompt "..." [--strong|--subtle]
 *   node niji-act.mjs zoom   --job <job_id> --index <i> [--factor 2] [--prompt "..."]
 *   node niji-act.mjs pan    --job <job_id> --index <i> --dir up|down|left|right [--prompt "..."]
 *   node niji-act.mjs ar     --job <job_id> --index <i> --ar 16:9 [--prompt "..."]
 *   node niji-act.mjs repaint --job <job_id> --index <i> --mask <file.png> --prompt "..."   (实验性)
 *
 * 通用选项:
 *   --relax / --private      提交模式（默认 fast / 公开）
 *   --out <dir>            输出目录
 *   --name <prefix>        文件名前缀
 *   --no-jpg               只保留 webp
 *   --max-w <px>           JPG 最大边，默认 1400
 *   --config <path>        配置文件路径
 *
 * 注意:
 *   - --job 是「源 grid 的任务 id」；--index 是该 grid 内 0–3 的图片序号（U1=0, U2=1, U3=2, U4=3）。
 *   - upscale 在当前镜像站不可用（代理服务端缺陷，非载荷问题），运行时会给出原因与替代方案。
 *   - zoom/pan/ar 若省略 --prompt，则自动拉取父 grid 的 prompt 作为 newPrompt。
 *   - repaint 为实验性：需要你提供一张与图同尺寸的遮罩 PNG，alphaMask 以 base64 发送，parent/frame 用整图边界近似。
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const CONFIG_CANDIDATES = [
  path.join(SKILL_ROOT, 'niji-web.config.json'),
  path.join(path.resolve(SKILL_ROOT, '..'), 'niji-web.config.json'),
];

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const OP = argv[0];
if (!OP || OP.startsWith('--')) {
  console.error('用法: node niji-act.mjs <upscale|vary|reroll|remix|zoom|pan|ar|repaint> --job <id> --index <i> ...');
  process.exit(1);
}
function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const hasFlag = (name) => argv.includes(name);

// ---------- 加载配置 ----------
function loadConfig() {
  const candidates = [arg('--config', null), process.env.NIJI_CONFIG, ...CONFIG_CANDIDATES].filter(Boolean);
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return { cfg: JSON.parse(fs.readFileSync(f, 'utf8')), file: f }; }
    catch (e) { console.error(`配置文件解析失败: ${f} — ${e.message}`); process.exit(1); }
  }
  return { cfg: {}, file: null };
}
const { cfg, file: cfgFile } = loadConfig();
const HOST = cfg.host || process.env.NIJI_HOST || '';
const USER_ID = cfg.userId || process.env.NIJI_USER_ID || '';
const CHANNEL_ID = cfg.channelId || (USER_ID ? `singleplayer_${USER_ID}` : '');
const CDN = cfg.cdn || process.env.NIJI_CDN || '';

function loadCookie() {
  if (cfg.cookie) return String(cfg.cookie).trim();
  if (process.env.NIJI_COOKIE) return process.env.NIJI_COOKIE.trim();
  const f = CONFIG_CANDIDATES.map((c) => c.replace(/config\.json$/, 'cookie.txt')).find((p) => fs.existsSync(p));
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const COOKIE = loadCookie();

const missing = [];
if (!HOST) missing.push('host');
if (!COOKIE) missing.push('cookie');
if (missing.length) {
  console.error(`配置缺失: ${missing.join('、')}`);
  console.error(`当前配置来源: ${cfgFile || '(未找到)'}`);
  process.exit(1);
}

const opts = {
  op: OP,
  job: arg('--job', ''),
  index: Number(arg('--index', '0')),
  prompt: arg('--prompt', ''),
  strong: hasFlag('--strong'),
  subtle: hasFlag('--subtle'),
  factor: Number(arg('--factor', '2')),
  dir: arg('--dir', 'up'),
  ar: arg('--ar', ''),
  mask: arg('--mask', ''),
  mode: hasFlag('--relax') ? 'relax' : 'fast',
  private: hasFlag('--private'),
  out: arg('--out', path.join(process.cwd(), 'outputs')),
  name: arg('--name', `niji-${OP}`),
  jpg: !hasFlag('--no-jpg'),
  maxW: Number(arg('--max-w', '1400')),
};

if (!opts.job) { console.error('缺少 --job <源 grid 任务 id>'); process.exit(1); }
if (['upscale', 'vary', 'remix', 'zoom', 'pan', 'ar', 'repaint'].includes(opts.op) && Number.isNaN(opts.index)) {
  console.error(`操作 ${opts.op} 需要 --index <0-3>`); process.exit(1);
}
if (['remix', 'repaint'].includes(opts.op) && !opts.prompt) { console.error(`操作 ${opts.op} 需要 --prompt`); process.exit(1); }
if (opts.op === 'pan' && !['up', 'down', 'left', 'right'].includes(opts.dir)) {
  console.error('--dir 必须是 up/down/left/right'); process.exit(1);
}
if (opts.op === 'ar' && !/^\d+:\d+$/.test(opts.ar)) { console.error('--ar 必须是 W:H 格式，如 16:9'); process.exit(1); }
if (opts.op === 'repaint' && !opts.mask) { console.error('repaint 需要 --mask <遮罩PNG>'); process.exit(1); }

// ---------- HTTP ----------
const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });
function request(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const headers = {
      Cookie: COOKIE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
      Origin: `https://${HOST}`,
      Referer: `https://${HOST}/imagine`,
      Accept: 'application/json',
      'X-CSRF-Protection': '1',
    };
    let payload = null;
    if (bodyObj) {
      payload = Buffer.from(JSON.stringify(bodyObj));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = https.request(
      { hostname: HOST, path: urlPath, method, headers, agent, timeout: 30000 },
      (res) => {
        let d = ''; res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let parsed = null; try { parsed = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, body: parsed, raw: d });
        });
      });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' }, agent }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载失败 ${res.statusCode}: ${url}`)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
      f.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('下载超时')));
  });
}

// ---------- 父 grid 信息 ----------
async function jobStatus(jobId) {
  const res = await request('POST', '/api/job-status', { jobIds: [jobId], _frontend_source: 'useJobSubmitter_fetchJobStatus' });
  if (res.status !== 200 || !Array.isArray(res.body) || !res.body.length) throw new Error(`查询任务失败: ${(res.raw || '').slice(0, 200)}`);
  return res.body[0];
}
function promptVersion(job) {
  const p = job.prompt;
  if (typeof p === 'string') return null;        // 旧式字符串 prompt
  if (p && p.version) return String(p.version);
  return null;
}
function upscaleTypeFor(version) {
  if (!version) return 'v8_virtual';
  if (['8', '8.1', '8.2'].includes(version)) return 'v8_virtual';
  if (['7', 'niji 7'].includes(version)) return 'v7_virtual';
  if (['6', '6.1', 'niji 6'].includes(version)) return 'v6_virtual';
  if (['5', '5.1'].includes(version)) return 'v5_virtual';
  return 'v8_virtual';
}
const PAN_DIR = { down: 0, right: 1, up: 2, left: 3 };

// ---------- 构建 body（与官方 web 客户端一致） ----------
async function buildBody() {
  const base = {
    f: { mode: opts.mode, private: opts.private },
    channelId: CHANNEL_ID,
    metadata: { isMobile: null, imagePrompts: 0, imageReferences: 0, characterReferences: 0, depthReferences: 0, lightboxOpen: null },
  };
  const id = opts.job;
  const index = opts.index;

  switch (opts.op) {
    case 'upscale': {
      const job = await jobStatus(id);
      const ver = promptVersion(job) || (job.full_command ? '8.2' : '8.2');
      // 与官方 web 客户端一致的载荷：t='upscale' + type=<变体>（如 v8_virtual）。
      // 注意：该镜像站在服务端不支持 upscale（见 SKILL.md「已知限制」），
      // 保留此载荷是为了站点修复后能自动可用。
      return { ...base, t: 'upscale', type: upscaleTypeFor(ver), id, index };
    }
    case 'vary': {
      return { ...base, t: 'vary', strong: opts.strong && !opts.subtle, v8_1_hd: null, v8_2_hd: null, id, index };
    }
    case 'reroll': {
      const b = { ...base, t: 'reroll', id };
      if (opts.prompt) b.newPrompt = opts.prompt;
      return b;
    }
    case 'remix': {
      const b = { ...base, t: 'remix', strong: opts.strong && !opts.subtle, newPrompt: opts.prompt, id, index };
      return b;
    }
    case 'zoom': {
      const job = await jobStatus(id);
      const newPrompt = opts.prompt || job.full_command || '';
      const zoomFactor = Math.round(50 + (100 - (opts.factor - 1) * 100) / 2); // 复刻前端 kve()
      return { ...base, t: 'outpaint', newPrompt, zoomFactor, id, index };
    }
    case 'ar': {
      const job = await jobStatus(id);
      const newPrompt = opts.prompt || job.full_command || '';
      const appended = newPrompt.trim().replace(/\s+--ar\s+\S+/i, '') + ` --ar ${opts.ar}`;
      return { ...base, t: 'outpaint', newPrompt: appended.trim(), zoomFactor: 100, id, index };
    }
    case 'pan': {
      const job = await jobStatus(id);
      const newPrompt = opts.prompt || job.full_command || '';
      return { ...base, t: 'pan', newPrompt, direction: PAN_DIR[opts.dir], fraction: 0.5, stitch: true, id, index }; // 0.5 == 官方 UI fraction 1.5 (_ve)
    }
    case 'repaint': {
      // 实验性：alphaMask 以 base64 PNG 发送；parent/frame 用整图边界近似
      const job = await jobStatus(id);
      const maskB64 = fs.readFileSync(opts.mask).toString('base64');
      const w = job.width || 1024, h = job.height || 1024;
      return {
        ...base, t: 'repaint', parentGridIndex: index,
        frame: { width: w, height: h },
        parent: { x: 0, y: 0, width: w, height: h },
        alphaMask: `data:image/png;base64,${maskB64}`,
        imagineString: opts.prompt,
        imagePrompts: [], imageReferences: [], characterReferences: [], depthReferences: [],
        rotationAngle: 0, id, index,
      };
    }
    default:
      throw new Error(`未知操作: ${opts.op}`);
  }
}

// ---------- 提交 ----------
// upscale 的根因说明：镜像站代理存在服务端缺陷（同一字段既要对象又要字符串），
// 与请求端载荷无关，因此单独给出可操作提示而非含糊的 "Unknown submit type"。
function upscaleHelp(err) {
  return [
    `upscale (U1–U4) 提交失败: ${err}`,
    '',
    '原因：该镜像站的代理服务对 upscale 有服务端缺陷，与请求载荷无关。实测：',
    '  · 官方载荷 t=upscale + type=v8_virtual  → "Unknown submit type"',
    '  · 改用 type=upscale 并通过校验（prompt 为对象）→ 服务端抛',
    '    "prompt.replaceAll is not a function"（同一字段既要求对象又要求字符串）',
    '  · prompt 以字符串 / 对象 / 嵌套对象 / 同级字段等 20+ 种组合提交，均复现同一错误',
    '',
    '替代方案：',
    '  1) 在网页端打开该 grid，手动点击 U1–U4 放大',
    '  2) 用已验证可用的操作代替：vary / reroll / remix / zoom / pan / ar',
    '  3) 需要单张大图时：先 zoom/pan 生成，再下载（本脚本已验证可用）',
  ].join('\n');
}

async function submit(body) {
  const res = await request('POST', '/api/submit-jobs', body);
  const failMsg = res.body?.failure?.[0]?.message;
  if (res.status !== 200) {
    const err = res.body?.error || (res.raw || '').slice(0, 200) || `HTTP ${res.status}`;
    if (opts.op === 'upscale') throw new Error(upscaleHelp(err));
    throw new Error(`提交失败: ${err}`);
  }
  const ok = res.body?.success?.[0];
  if (!ok) {
    const msg = failMsg || (res.raw || '').slice(0, 200);
    if (opts.op === 'upscale') throw new Error(upscaleHelp(msg));
    throw new Error(`提交未返回 job_id: ${msg}`);
  }
  return ok.job_id;
}

// ---------- 轮询 ----------
async function waitForJob(jobId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 800;
  while (Date.now() < deadline) {
    const res = await request('POST', '/api/job-status', { jobIds: [jobId], _frontend_source: 'useJobSubmitter_fetchJobStatus' });
    if (res.status === 200 && Array.isArray(res.body) && res.body.length) {
      const job = res.body[0];
      if (job.current_status === 'completed') return job;
      if (job.current_status === 'failed' || job.current_status === 'error') throw new Error(`任务失败: ${job.current_status}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), 3000);
  }
  throw new Error(`等待超时 (${timeoutMs / 1000}s)`);
}

// ---------- 下载 ----------
function cdnBase() {
  if (CDN) return CDN.replace(/\/+$/, '');
  return `https://cdn-${HOST.split('.').slice(1).join('.')}`;
}
async function downloadAll(jobId, job) {
  fs.mkdirSync(opts.out, { recursive: true });
  const count = job.batch_size || 1;
  const base = cdnBase();
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const cdnUrl = `${base}/${jobId}/0_${i}.webp`;
    const dest = path.join(opts.out, `${opts.name}_${i}.webp`);
    tasks.push(
      download(cdnUrl, dest)
        .then(() => ({ index: i, file: dest, cdnUrl, bytes: fs.statSync(dest).size }))
        .catch((e) => ({ index: i, error: e.message }))
    );
  }
  return Promise.all(tasks);
}

// ---------- 转 JPG（常驻 Python worker，复用 niji-gen 逻辑） ----------
const WORKER_CODE = `
import json, sys
from PIL import Image
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        s = json.loads(line)
        if s.get('cmd') == 'quit':
            break
        im = Image.open(s['src']).convert('RGB')
        im.thumbnail((s['maxW'], s['maxW']), Image.LANCZOS)
        im.save(s['dst'], 'JPEG', quality=88)
        print(json.dumps({'dst': s['dst'], 'ok': True}), flush=True)
    except Exception as ex:
        print(json.dumps({'dst': s.get('dst'), 'ok': False, 'err': str(ex)}), flush=True)
`;
function findPython() {
  const candidates = [];
  if (process.env.NIJI_PYTHON) candidates.push(process.env.NIJI_PYTHON);
  for (const p of ['python', 'python3', 'py']) candidates.push(p);
  candidates.push(
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python'),
  );
  for (const c of candidates) {
    try { const r = spawnSync(c, ['-c', 'import PIL'], { encoding: 'utf8', timeout: 10000 }); if (r.status === 0) return c; } catch {}
  }
  return null;
}
function startConverter() {
  if (!opts.jpg) return null;
  const py = findPython();
  if (!py) return null;
  const worker = spawn(py, ['-u', '-c', WORKER_CODE], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = []; let buf = '';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    buf += chunk; let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pending.shift(); if (resolver) resolver(msg);
    }
  });
  worker.on('error', () => {});
  return {
    send(msg) { return new Promise((resolve) => { pending.push(resolve); worker.stdin.write(JSON.stringify(msg) + '\n'); }); },
    stop() { try { worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch {} worker.kill(); },
  };
}
async function toJpgBatch(converter, webpPaths) {
  const map = new Map();
  if (!converter || !webpPaths.length) return map;
  for (const src of webpPaths) {
    const dst = src.replace(/\.webp$/, '.jpg');
    const res = await converter.send({ cmd: 'convert', src, dst, maxW: opts.maxW });
    if (res && res.ok && fs.existsSync(dst)) map.set(src, dst);
  }
  return map;
}

// ---------- 主流程 ----------
(async () => {
  const t0 = Date.now();
  const body = await buildBody();
  const tBuild = Date.now() - t0;
  const jobId = await submit(body);
  const tSubmit = Date.now() - t0 - tBuild;
  const converter = startConverter();
  const job = await waitForJob(jobId);
  const images = await downloadAll(jobId, job);
  const jpgMap = await toJpgBatch(converter, images.filter((i) => i.file).map((i) => i.file));
  if (converter) converter.stop();
  for (const img of images) if (img.file) { const j = jpgMap.get(img.file); if (j) img.jpg = j; }
  console.log(JSON.stringify({
    op: opts.op, parent_job: opts.job, parent_index: opts.index,
    job_id: jobId, prompt: job.full_command, width: job.width, height: job.height,
    status: job.current_status,
    timings_ms: { build: tBuild, submit: tSubmit, wait: Date.now() - t0 - tSubmit, total: Date.now() - t0 },
    images,
  }, null, 2));
  agent.destroy();
})().catch((e) => { console.error('错误: ' + e.message); process.exit(1); });

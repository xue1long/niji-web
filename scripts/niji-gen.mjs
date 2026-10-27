#!/usr/bin/env node
/**
 * niji-gen.mjs — Midjourney 镜像站生图 CLI（可移植版）
 *
 * 站点/账号/图片 CDN 全部从配置文件读取，不硬编码。配置由 discover.js 在浏览器内探测生成。
 *
 * 用法:
 *   node niji-gen.mjs "提示词" [选项]
 *
 * 选项:
 *   --ar <ratio>      宽高比，默认 16:9    例: 1:1 / 4:3 / 16:9 / 21:9 / 7:3
 *   --v <version>     版本，默认取配置值    例: 8.2 / 7 / 6.1
 *   --stylize <n>     风格化强度，默认 150
 *   --weird <n>       怪异度，默认 4
 *   --chaos <n>       多样性，默认 0
 *   --raw             字面模式
 *   --relax           慢速模式（默认 fast）
 *   --private         不公开
 *   --out <dir>       输出目录，默认 ./outputs
 *   --name <prefix>   文件名前缀，默认 niji
 *   --no-jpg          只保留 webp 原图，不转 JPG
 *   --max-w <px>      JPG 最大边，默认 1400
 *   --config <path>   配置文件路径（默认 <脚本目录>/../niji-web.config.json）
 *
 * 配置来源优先级:
 *   1. --config 指定的文件
 *   2. 环境变量 NIJI_CONFIG
 *   3. <脚本目录>/../niji-web.config.json
 *   4. 环境变量 NIJI_HOST / NIJI_USER_ID / NIJI_CDN / NIJI_COOKIE
 *
 * Cookie 来源:
 *   1. 配置里的 cookie 字段
 *   2. 环境变量 NIJI_COOKIE
 *   3. <脚本目录>/../niji-web.cookie.txt
 *
 * 输出: stdout 打印 JSON，含 job_id / images[] / timings_ms
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 技能根目录（scripts/ 的上一级）
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
// 配置查找范围：技能目录内、技能目录的同级父目录，以及二者
// 用 resolve 而非 join，确保 '..' 正确上跳
const CONFIG_CANDIDATES = [
  path.join(SKILL_ROOT, 'niji-web.config.json'),
  path.join(path.resolve(SKILL_ROOT, '..'), 'niji-web.config.json'),
];

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const prompt = argv[0];
if (!prompt || prompt.startsWith('--')) {
  console.error('用法: node niji-gen.mjs "提示词" [--ar 16:9] [--v 8.2] [--stylize 150] [--out dir]');
  console.error('首次使用请先运行 scripts/discover.js 生成 niji-web.config.json');
  process.exit(1);
}

function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const hasFlag = (name) => argv.includes(name);

// ---------- 加载配置 ----------
function loadConfig() {
  const candidates = [
    arg('--config', null),
    process.env.NIJI_CONFIG,
    ...CONFIG_CANDIDATES,
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return { cfg: JSON.parse(fs.readFileSync(f, 'utf8')), file: f };
    } catch (e) {
      console.error(`配置文件解析失败: ${f} — ${e.message}`);
      process.exit(1);
    }
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
  const f = CONFIG_CANDIDATES.map((c) => c.replace(/config\.json$/, 'cookie.txt'))
    .find((p) => fs.existsSync(p));
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return '';
}
const COOKIE = loadCookie();

const missing = [];
if (!HOST) missing.push('host (站点域名)');
if (!COOKIE) missing.push('cookie (会话 Cookie)');
if (missing.length) {
  console.error(`配置缺失: ${missing.join('、')}`);
  console.error('请在浏览器打开站点生图页，用 scripts/discover.js 探测生成 niji-web.config.json');
  console.error(`当前配置来源: ${cfgFile || '(未找到配置文件)'}`);
  process.exit(1);
}

const opts = {
  ar: arg('--ar', '16:9'),
  version: arg('--v', cfg.version || '8.2'),
  stylize: arg('--stylize', '150'),
  weird: arg('--weird', '4'),
  chaos: arg('--chaos', '0'),
  raw: hasFlag('--raw'),
  mode: hasFlag('--relax') ? 'relax' : 'fast',
  private: hasFlag('--private'),
  out: arg('--out', path.join(process.cwd(), 'outputs')),
  name: arg('--name', 'niji'),
  jpg: !hasFlag('--no-jpg'),
  maxW: Number(arg('--max-w', '1400')),
};

// ---------- HTTP（keep-alive 复用连接） ----------
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
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(d); } catch { /* 非 JSON 原样返回 */ }
          resolve({ status: res.statusCode, body: parsed, raw: d });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' }, agent },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 ${res.statusCode}: ${url}`));
        }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(dest)));
        f.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('下载超时')));
  });
}

// ---------- 步骤 1: 提交 ----------
function buildPrompt() {
  const parts = [prompt];
  parts.push(`--ar ${opts.ar}`);
  if (opts.raw) parts.push('--raw');
  if (Number(opts.stylize) > 0) parts.push(`--stylize ${opts.stylize}`);
  if (Number(opts.weird) > 0) parts.push(`--weird ${opts.weird}`);
  if (Number(opts.chaos) > 0) parts.push(`--chaos ${opts.chaos}`);
  parts.push(`--v ${opts.version}`);
  return parts.join(' ');
}

async function submit() {
  const body = {
    f: { mode: opts.mode, private: opts.private },
    metadata: {
      isMobile: null, imagePrompts: 0, imageReferences: 0,
      characterReferences: 0, depthReferences: 0, lightboxOpen: null,
    },
    t: 'imagine',
    prompt: buildPrompt(),
  };
  if (CHANNEL_ID) body.channelId = CHANNEL_ID;
  const res = await request('POST', '/api/submit-jobs', body);
  if (res.status !== 200) {
    const err = res.body?.error
      || (res.raw || '').slice(0, 200)
      || `HTTP ${res.status}`;
    throw new Error(`提交失败: ${err}`);
  }
  const ok = res.body?.success?.[0];
  if (!ok) throw new Error(`提交未返回 job_id: ${(res.raw || '').slice(0, 200)}`);
  return ok.job_id;
}

// ---------- 步骤 2: 轮询状态（指数退避） ----------
async function waitForJob(jobId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 800;
  while (Date.now() < deadline) {
    const res = await request('POST', '/api/job-status', {
      jobIds: [jobId],
      _frontend_source: 'useJobSubmitter_fetchJobStatus',
    });
    if (res.status === 200 && Array.isArray(res.body) && res.body.length) {
      const job = res.body[0];
      if (job.current_status === 'completed') return job;
      if (job.current_status === 'failed' || job.current_status === 'error') {
        throw new Error(`任务失败: ${job.current_status}`);
      }
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), 3000);
  }
  throw new Error(`等待超时 (${timeoutMs / 1000}s)`);
}

// ---------- 步骤 3: 并发下载 ----------
function cdnBase() {
  if (CDN) return CDN.replace(/\/+$/, '');
  // 未配置 CDN 时按站点域名推导（镜像站 CDN 通常为 cdn-{站点去掉首段}）
  return `https://cdn-${HOST.split('.').slice(1).join('.')}`;
}

async function downloadAll(jobId, job) {
  fs.mkdirSync(opts.out, { recursive: true });
  const count = job.batch_size || 4;
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

// ---------- 步骤 4: 转 JPG（常驻 Python worker） ----------
// 常驻 worker：stdin 收 JSON 行，stdout 回 JSON 行。
// 关键：在提交任务后立刻启动，此时它 import PIL 的 ~1.6s 与服务端出图等待完全重叠。
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

// 依次尝试：显式配置 → PATH 上的 python → 常见位置
function findPython() {
  const candidates = [];
  if (process.env.NIJI_PYTHON) candidates.push(process.env.NIJI_PYTHON);
  for (const p of ['python', 'python3', 'py']) candidates.push(p);
  candidates.push(
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python'),
  );
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import PIL'], { encoding: 'utf8', timeout: 10000 });
      if (r.status === 0) return c;
    } catch { /* 候选不存在则跳过 */ }
  }
  return null;
}

function startConverter() {
  if (!opts.jpg) return null;
  const py = findPython();
  if (!py) return null;

  const worker = spawn(py, ['-u', '-c', WORKER_CODE], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = [];
  let buf = '';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pending.shift();
      if (resolver) resolver(msg);
    }
  });
  worker.on('error', () => {});

  return {
    send(msg) {
      return new Promise((resolve) => {
        pending.push(resolve);
        worker.stdin.write(JSON.stringify(msg) + '\n');
      });
    },
    stop() {
      try { worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* ignore */ }
      worker.kill();
    },
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
  const jobId = await submit();
  const tSubmit = Date.now() - t0;

  // 立刻启动转换器：它的 Python 冷启动(~1.6s) 与服务端出图等待完全重叠
  const converter = startConverter();

  const t1 = Date.now();
  const job = await waitForJob(jobId);
  const tWait = Date.now() - t1;

  const t2 = Date.now();
  const images = await downloadAll(jobId, job);
  const tDownload = Date.now() - t2;

  const t3 = Date.now();
  const jpgMap = await toJpgBatch(converter, images.filter((i) => i.file).map((i) => i.file));
  const tConvert = Date.now() - t3;
  if (converter) converter.stop();

  for (const img of images) {
    if (img.file) {
      const jpg = jpgMap.get(img.file);
      if (jpg) img.jpg = jpg;
    }
  }

  console.log(JSON.stringify({
    job_id: jobId,
    prompt: job.full_command,
    width: job.width,
    height: job.height,
    status: job.current_status,
    timings_ms: {
      submit: tSubmit,
      wait_generate: tWait,
      download: tDownload,
      convert: tConvert,
      total: Date.now() - t0,
    },
    images,
  }, null, 2));
  agent.destroy();
})().catch((e) => {
  console.error('错误: ' + e.message);
  process.exit(1);
});

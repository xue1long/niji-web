#!/usr/bin/env node
/**
 * niji-describe.mjs — Midjourney 镜像站「图生文」CLI（可移植版）
 *
 * 上传一张图片（本地文件或图片 URL），调用站点 /api/describe，
 * 返回 Midjourney 生成的 4 条提示词。
 *
 * 用法:
 *   node niji-describe.mjs <图片路径或URL> [选项]
 *
 * 选项:
 *   --config <path>   配置文件路径（默认 <脚本目录>/../niji-web.config.json）
 *   --out <dir>       把 4 条提示词写成 describe.json 存到该目录
 *   --name <prefix>   输出文件名前缀，默认 describe
 *   --json            仅输出 JSON（programmatic）
 *
 * 配置来源优先级: 同 niji-gen.mjs（--config > NIJI_CONFIG > 技能目录 config > 环境变量）
 * Cookie 来源:       同 niji-gen.mjs
 *
 * 依赖: Node.js 18+（使用内置 fetch / FormData / Blob）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const CONFIG_CANDIDATES = [
  path.join(SKILL_ROOT, 'niji-web.config.json'),
  path.join(path.resolve(SKILL_ROOT, '..'), 'niji-web.config.json'),
];

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('用法: node niji-describe.mjs <图片路径或URL> [--out dir] [--name prefix] [--json]');
  process.exit(1);
}

const hasFlag = (n) => argv.includes(n);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

// ---------- 加载配置 ----------
function loadConfig() {
  const candidates = [arg('--config', null), process.env.NIJI_CONFIG, ...CONFIG_CANDIDATES].filter(Boolean);
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
function loadCookie() {
  if (cfg.cookie) return String(cfg.cookie).trim();
  if (process.env.NIJI_COOKIE) return process.env.NIJI_COOKIE.trim();
  const f = CONFIG_CANDIDATES.map((c) => c.replace(/config\.json$/, 'cookie.txt')).find((p) => fs.existsSync(p));
  return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
}
const COOKIE = loadCookie();
const CDN = cfg.cdn || (HOST ? `https://cdn-${HOST.split('.').slice(1).join('.')}` : '');

const missing = [];
if (!HOST) missing.push('host');
if (!COOKIE) missing.push('cookie');
if (missing.length) {
  console.error(`配置缺失: ${missing.join('、')}`);
  console.error(`当前配置来源: ${cfgFile || '(未找到配置文件)'}`);
  process.exit(1);
}

const opts = {
  out: arg('--out', null),
  name: arg('--name', 'describe'),
  jsonOnly: hasFlag('--json'),
};

const baseHeaders = (extra = {}) => ({ Cookie: COOKIE, 'X-CSRF-Protection': '1', ...extra });

// ---------- 上传：本地文件 → 站点 storage → 可访问 URL ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function uploadLocalFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `image${ext || '.png'}`);
  const res = await fetch(`https://${HOST}/api/storage-upload-file?source=editor`, {
    method: 'POST',
    body: form,
    headers: baseHeaders(),
  });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const bucket = j.bucketPathname;
  if (!bucket) throw new Error(`上传返回缺少 bucketPathname: ${JSON.stringify(j).slice(0, 200)}`);
  // KS(e) = `${CDN}/e/${e}` —— 站点内部把 bucketPathname 转成可访问 URL 的方式
  return `${CDN.replace(/\/+$/, '')}/e/${String(bucket).replace(/^\/+/, '')}`;
}

// ---------- 上传：外部 URL → 站内 shortUrl ----------
async function uploadUrl(imageUrl) {
  if (imageUrl.startsWith(CDN)) return imageUrl; // 已是站内 CDN，直接用
  const res = await fetch(`https://${HOST}/api/storage-upload-link`, {
    method: 'POST',
    body: JSON.stringify({ url: imageUrl }),
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!res.ok) throw new Error(`转存 URL 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.shortUrl) throw new Error(`转存返回缺少 shortUrl: ${JSON.stringify(j).slice(0, 200)}`);
  return j.shortUrl;
}

// ---------- 调用 /api/describe ----------
async function describe(imageUrl) {
  const res = await fetch(`https://${HOST}/api/describe`, {
    method: 'POST',
    body: JSON.stringify({ image_url: imageUrl }),
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`describe 失败 HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const body = await res.json();
  // 兼容两种返回结构：{ data: { descriptions: [...] } } 或 { descriptions: [...] }
  const descriptions =
    (body?.data && body.data.descriptions) ||
    body?.descriptions ||
    null;
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    throw new Error(`describe 返回缺少 descriptions: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return descriptions;
}

// ---------- 主流程 ----------
(async () => {
  const t0 = Date.now();
  let imageUrl;
  if (/^https?:\/\//i.test(src)) {
    imageUrl = await uploadUrl(src);
  } else {
    if (!fs.existsSync(src)) {
      console.error(`图片文件不存在: ${src}`);
      process.exit(1);
    }
    imageUrl = await uploadLocalFile(src);
  }
  const descriptions = await describe(imageUrl);

  const result = {
    image_url: imageUrl,
    descriptions,
    count: descriptions.length,
    elapsed_ms: Date.now() - t0,
  };

  if (opts.jsonOnly) {
    process.stdout.write(JSON.stringify(result, null, 2));
  } else {
    console.log(`图片: ${imageUrl}`);
    console.log(`生成 ${descriptions.length} 条提示词:\n`);
    descriptions.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  }

  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const dest = path.join(opts.out, `${opts.name}.json`);
    fs.writeFileSync(dest, JSON.stringify(result, null, 2));
    if (!opts.jsonOnly) console.log(`\n已保存: ${dest}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('错误: ' + e.message);
  process.exit(1);
});

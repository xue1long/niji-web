#!/usr/bin/env node
/**
 * init-config.mjs — 由探测结果生成 niji-web.config.json
 *
 * 用法:
 *   node init-config.mjs --from <discover输出.json>            # 直接吃 discover.js 的输出
 *   node init-config.mjs --host <域名> --cdn <CDN前缀> --user-id <uuid> --cookie "<cookie串>"
 *
 * 写出的配置文件默认放在 <脚本目录>/../niji-web.config.json
 * 也可用 --out <path> 或环境变量 NIJI_CONFIG 指定。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 技能根目录（scripts/ 的上一级）
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
// 配置默认落在技能目录的同级父目录，避免被误打包进分发 zip
const DEFAULT_CONFIG_PATH = path.join(path.resolve(SKILL_ROOT, '..'), 'niji-web.config.json');
const argv = process.argv.slice(2);

function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

const outPath = arg('--out', process.env.NIJI_CONFIG || DEFAULT_CONFIG_PATH);

let cfg = {};
const from = arg('--from', null);
if (from) {
  if (!fs.existsSync(from)) {
    console.error(`找不到探测结果文件: ${from}`);
    process.exit(1);
  }
  cfg = JSON.parse(fs.readFileSync(from, 'utf8'));
} else {
  cfg = {
    host: arg('--host', ''),
    cdn: arg('--cdn', ''),
    userId: arg('--user-id', ''),
    channelId: arg('--channel-id', ''),
    cookie: arg('--cookie', ''),
    service: arg('--service', ''),
    version: arg('--version', ''),
  };
}

if (!cfg.channelId && cfg.userId) cfg.channelId = 'singleplayer_' + cfg.userId;

// 校验必填项
const missing = [];
if (!cfg.host) missing.push('host');
if (!cfg.cookie) missing.push('cookie');
if (missing.length) {
  console.error(`配置缺少必填项: ${missing.join(', ')}`);
  console.error('提示：先在浏览器打开站点生图页，运行 scripts/discover.js 拿到完整信息。');
  process.exit(1);
}

// 归一化 host / cdn（去掉协议前缀与末尾斜杠）
if (cfg.host) cfg.host = String(cfg.host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
if (cfg.cdn) cfg.cdn = String(cfg.cdn).replace(/\/+$/, '');

cfg.discoveredAt = new Date().toISOString();
cfg.generator = 'niji-web init-config.mjs';

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2), 'utf8');

console.error(`配置已写入: ${outPath}`);
console.error(JSON.stringify({
  host: cfg.host,
  cdn: cfg.cdn,
  userId: cfg.userId,
  channelId: cfg.channelId,
  service: cfg.service,
  version: cfg.version,
  cookieLength: String(cfg.cookie).length,
}, null, 2));

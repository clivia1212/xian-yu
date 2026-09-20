#!/usr/bin/env node
/**
 * 草料二维码 · 图片码一键生成
 *
 * 输入：一个 zip（或已解压的文件夹）。每个子文件夹 = 一份报告 = 一个二维码，
 *      文件夹里的图片按顺序逐张上传，码标题取文件夹名中的中文部分。
 * 输出：<out>/<标题>.png（二维码图片）+ <out>/results.json + <out>/结果.md
 *
 * 用法：
 *   node caoliao-qr/make_qr.cjs "检测报告 (1).zip"                 # 正式生成
 *   node caoliao-qr/make_qr.cjs "检测报告 (1).zip" --dry-run       # 只看分组与标题，不联网
 *   node caoliao-qr/make_qr.cjs --login                            # 登录一次，保存登录态
 *   node caoliao-qr/make_qr.cjs --inspect                          # 抓取页面元素，便于调整选择器
 *
 * 登录态来源（按优先级）：
 *   1. --cookie "k=v; k2=v2"  或环境变量 CAOLIAO_COOKIE（从浏览器复制的 Cookie 串）
 *   2. 环境变量 CAOLIAO_STORAGE_STATE_B64（--login 生成的 state 文件 base64）
 *   3. --state 文件（默认 caoliao-qr/state/caoliao-state.json）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------- 配置

const DEFAULT_BASE_URL = 'https://cli.im';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const HERE = __dirname;

/**
 * 页面元素候选选择器：草料改版后只需要在这里调整。
 * 每一项是候选列表，脚本依次尝试，取第一个可见的。
 * 用 `--inspect` 可以把当前页面的按钮/输入框/占位符导出，方便对照修改。
 */
const SEL = {
  imagePagePath: '/img',
  loginPagePath: '/login',
  // 未登录时页面上会出现的“登录”入口
  loginEntry: ['a:has-text("登录")', 'button:has-text("登录")', 'text=/^登录$/'],
  // 已登录的标志（任意一个可见即视为已登录）
  loggedInMark: ['text=退出登录', 'text=我的二维码', 'text=退出', '[class*="avatar"]', '[class*="user-name"]', '[class*="username"]'],
  fileInput: ['input[type="file"]'],
  titleInput: [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="名称"]',
    '[contenteditable="true"][placeholder*="标题"]',
  ],
  generateButton: [
    'button:has-text("生成二维码")',
    'a:has-text("生成二维码")',
    'button:has-text("生成活码")',
    'button:has-text("生成")',
    'text=/^生成二维码$/',
  ],
  qrImage: [
    'img[src*="qr"]',
    'img[src^="data:image"]',
    '[class*="qrcode"] img',
    '[class*="qr-code"] img',
    '[class*="qrcode"] canvas',
    'canvas',
  ],
  downloadButton: ['button:has-text("下载")', 'a:has-text("下载")', 'text=/^下载/'],
  downloadFormat: ['text=/^PNG$/i', 'text=/png/i', 'text=/高清/'],
  uploading: ['text=上传中', 'text=/上传中/', '[class*="uploading"]', '[class*="progress"]'],
  // 有时会弹公告/引导，尽量关掉
  dismiss: ['text=我知道了', 'text=关闭', 'text=跳过', '[class*="close"]'],
};

// 生成后的短链接（草料常见短域名）
const SHORT_URL_RE = /https?:\/\/qr\d{2}\.cn\/[A-Za-z0-9_\-/]+/;

// ---------------------------------------------------------------- CLI 参数

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n'));
}

// ---------------------------------------------------------------- 工具函数

const log = (...m) => console.log('[草料]', ...m);
const warn = (...m) => console.warn('[草料][警告]', ...m);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled';
}

/** 自然排序：让 _2 排在 _10 前面 */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 取名字里的“中文部分”：从第一个汉字到最后一个汉字（中间的连字符等保留）。
 *   "5.6-发电机"                     -> "发电机"
 *   "5.11-施工器具检测报告-鼓风机"    -> "施工器具检测报告-鼓风机"
 * 没有汉字时原样返回。
 */
function chineseTitle(name) {
  const chars = Array.from(name);
  let first = -1;
  let last = -1;
  chars.forEach((ch, i) => {
    if (CJK_RE.test(ch)) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) return name.trim();
  return chars.slice(first, last + 1).join('').trim();
}

/** 去掉 “_01” “-1” “(2)” 这类页码后缀，用于根目录散图分组 */
function stripPageSuffix(base) {
  return base.replace(/[\s_\-]*(?:\(\d+\)|\d+)$/u, '').trim() || base;
}

// ---------------------------------------------------------------- 解压

const PY_UNZIP = `
import sys, os, zipfile
src, dst = sys.argv[1], sys.argv[2]
dst_abs = os.path.abspath(dst)
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        name = info.filename
        if not (info.flag_bits & 0x800):
            raw = name.encode('cp437', errors='replace')
            for enc in ('utf-8', 'gbk'):
                try:
                    name = raw.decode(enc); break
                except Exception:
                    pass
        parts = [p for p in name.replace('\\\\', '/').split('/') if p]
        if not parts or parts[0] == '__MACOSX' or parts[-1] in ('.DS_Store', 'Thumbs.db') or parts[-1].startswith('._'):
            continue
        target = os.path.normpath(os.path.join(dst_abs, *parts))
        if not target.startswith(dst_abs):
            continue
        if info.is_dir() or name.endswith('/'):
            os.makedirs(target, exist_ok=True); continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as s, open(target, 'wb') as d:
            d.write(s.read())
print('ok')
`;

function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-c', PY_UNZIP, zipPath, destDir], { encoding: 'utf8' });
    if (r.status === 0) return;
    if (r.error && r.error.code === 'ENOENT') continue;
    warn(`${py} 解压失败：${(r.stderr || '').trim()}`);
  }
  // 兜底：系统 unzip
  const r = spawnSync('unzip', ['-o', '-q', '-O', 'UTF-8', zipPath, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`无法解压 ${zipPath}：请确认已安装 python3 或 unzip`);
  }
}

// ---------------------------------------------------------------- 分组

function walkImages(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkImages(p, out);
    else if (IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** 如果目录只有一个子目录且没有图片，就往下钻（zip 里常有一层同名外壳） */
function descendRoot(dir) {
  for (let i = 0; i < 5; i++) {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
    const dirs = ents.filter((e) => e.isDirectory());
    const files = ents.filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()));
    if (dirs.length === 1 && files.length === 0) dir = path.join(dir, dirs[0].name);
    else break;
  }
  return dir;
}

/**
 * 返回 [{ key, name, title, images: [绝对路径...] }]
 *  - 子文件夹里的图片 → 一个文件夹一个码，标题取文件夹名中文部分
 *  - 直接放在根目录的图片 → 按去掉页码后缀的文件名分组
 */
function collectGroups(rootDir, titleMode = 'chinese') {
  const root = descendRoot(rootDir);
  const groups = new Map();
  for (const img of walkImages(root)) {
    const rel = path.relative(root, img);
    const parent = path.dirname(rel);
    let key;
    let name;
    if (parent === '.' || parent === '') {
      name = stripPageSuffix(path.basename(img, path.extname(img)));
      key = `file:${name}`;
    } else {
      name = path.basename(parent);
      key = `dir:${parent}`;
    }
    if (!groups.has(key)) groups.set(key, { key, name, images: [] });
    groups.get(key).images.push(img);
  }
  const list = Array.from(groups.values());
  for (const g of list) {
    g.images.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
    g.title = titleMode === 'full' ? g.name : chineseTitle(g.name);
  }
  list.sort((a, b) => naturalCompare(a.name, b.name));
  return { root, groups: list };
}

// ---------------------------------------------------------------- Playwright

function loadPlaywright() {
  const names = ['playwright', 'playwright-core'];
  for (const n of names) {
    try {
      return require(n);
    } catch (_) {
      /* 继续 */
    }
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    for (const n of names) {
      try {
        return require(path.join(root, n));
      } catch (_) {
        /* 继续 */
      }
    }
  } catch (_) {
    /* 继续 */
  }
  throw new Error('找不到 playwright。请执行：npm i -g playwright && npx playwright install chromium');
}

function parseCookieHeader(cookieStr, baseUrl) {
  const host = new URL(baseUrl).hostname;
  const isIpOrLocal = host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':');
  // 域名站点用 ".cli.im" 这种父域，让所有子域都带上 cookie；IP/localhost 只能按 url 设置
  const scope = isIpOrLocal ? { url: baseUrl } : { domain: '.' + host.split('.').slice(-2).join('.'), path: '/' };
  return cookieStr
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      const name = i < 0 ? kv : kv.slice(0, i).trim();
      const value = i < 0 ? '' : kv.slice(i + 1).trim();
      return { name, value, ...scope, secure: baseUrl.startsWith('https'), sameSite: 'Lax' };
    });
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/** 以 {name, mimeType, buffer} 形式提供给 setInputFiles，保留原文件名 */
function filePayload(file) {
  return { name: path.basename(file), mimeType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', buffer: fs.readFileSync(file) };
}

async function firstVisible(page, candidates, timeoutMs = 1500) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: timeoutMs });
      return loc;
    } catch (_) {
      /* 下一个 */
    }
  }
  return null;
}

async function anyVisible(page, candidates) {
  for (const sel of candidates) {
    try {
      if (await page.locator(sel).first().isVisible()) return true;
    } catch (_) {
      /* 下一个 */
    }
  }
  return false;
}

async function dismissPopups(page) {
  for (const sel of SEL.dismiss) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 })) await loc.click({ timeout: 1000 });
    } catch (_) {
      /* 忽略 */
    }
  }
}

async function isLoggedIn(page) {
  if (await anyVisible(page, SEL.loggedInMark)) return true;
  if (await anyVisible(page, SEL.loginEntry)) return false;
  return true; // 既没有登录入口也没有明显标志，先当作已登录
}

async function waitUploadsSettle(page, maxMs = 60000) {
  const start = Date.now();
  await sleep(500);
  while (Date.now() - start < maxMs) {
    if (!(await anyVisible(page, SEL.uploading))) break;
    await sleep(500);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(300);
}

async function openContext(pw, opts) {
  const browser = await pw.chromium.launch({ headless: !opts.headed });
  const ctxOpts = {
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
  let source = '无';
  if (opts.cookie) {
    source = 'cookie';
  } else if (process.env.CAOLIAO_STORAGE_STATE_B64) {
    ctxOpts.storageState = JSON.parse(Buffer.from(process.env.CAOLIAO_STORAGE_STATE_B64, 'base64').toString('utf8'));
    source = '环境变量 CAOLIAO_STORAGE_STATE_B64';
  } else if (fs.existsSync(opts.state)) {
    ctxOpts.storageState = opts.state;
    source = `文件 ${opts.state}`;
  }
  const context = await browser.newContext(ctxOpts);
  if (opts.cookie) await context.addCookies(parseCookieHeader(opts.cookie, opts.baseUrl));
  log(`登录态来源：${source}`);
  return { browser, context };
}

async function saveState(context, statePath) {
  ensureDir(path.dirname(statePath));
  await context.storageState({ path: statePath });
  const b64 = Buffer.from(fs.readFileSync(statePath)).toString('base64');
  fs.writeFileSync(statePath + '.b64', b64);
  log(`登录态已保存：${statePath}`);
  log(`如需在云端环境复用，把 ${statePath}.b64 的内容设置为环境变量 CAOLIAO_STORAGE_STATE_B64`);
}

// ---------------------------------------------------------------- 模式：登录

async function doLogin(pw, opts) {
  const { browser, context } = await openContext(pw, opts);
  const page = await context.newPage();
  await page.goto(opts.baseUrl + SEL.loginPagePath, { waitUntil: 'domcontentloaded' }).catch(() => page.goto(opts.baseUrl));
  await sleep(1500);
  if (await isLoggedIn(page)) {
    log('当前已是登录状态。');
    await saveState(context, opts.state);
    await browser.close();
    return;
  }
  const shot = path.join(opts.out, 'login-screen.png');
  log(opts.headed ? '请在弹出的浏览器里完成登录（微信扫码/短信/密码均可）…' : `无界面模式：登录页截图会持续刷新到 ${shot}，请用微信扫描截图中的二维码登录…`);
  const deadline = Date.now() + Number(opts.loginTimeout || 300) * 1000;
  while (Date.now() < deadline) {
    if (!opts.headed) await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    if (await isLoggedIn(page)) {
      log('检测到已登录。');
      await saveState(context, opts.state);
      await browser.close();
      return;
    }
    await sleep(3000);
  }
  await browser.close();
  throw new Error('登录超时，未检测到登录成功。');
}

// ---------------------------------------------------------------- 模式：页面体检

async function doInspect(pw, opts) {
  const { browser, context } = await openContext(pw, opts);
  const page = await context.newPage();
  const url = opts.baseUrl + SEL.imagePagePath;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await dismissPopups(page);
  const info = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60);
    const pick = (sel, fn) => Array.from(document.querySelectorAll(sel)).filter(vis).map(fn).slice(0, 200);
    return {
      title: document.title,
      url: location.href,
      buttons: pick('button, [role="button"], a.btn, .btn', (el) => ({ tag: el.tagName, text: text(el), cls: el.className && String(el.className).slice(0, 80) })),
      inputs: pick('input, textarea, [contenteditable="true"]', (el) => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, name: el.name, cls: el.className && String(el.className).slice(0, 80) })),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({ accept: el.accept, multiple: el.multiple, cls: el.className && String(el.className).slice(0, 80) })),
      links: pick('a', (el) => ({ text: text(el), href: el.getAttribute('href') })).filter((l) => l.text),
      images: pick('img', (el) => ({ src: (el.currentSrc || el.src || '').slice(0, 120), w: el.width, h: el.height })),
    };
  });
  const jsonPath = path.join(opts.out, 'inspect.json');
  const pngPath = path.join(opts.out, 'inspect.png');
  fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
  await page.screenshot({ path: pngPath, fullPage: true });
  log(`页面元素已导出：${jsonPath}`);
  log(`页面截图：${pngPath}`);
  log(`登录状态：${(await isLoggedIn(page)) ? '已登录' : '未登录'}`);
  await browser.close();
}

// ---------------------------------------------------------------- 模式：生成

async function createOne(page, group, opts, index, total) {
  const tag = `[${index}/${total}] ${group.title}`;
  log(`${tag}：打开图片码页面…`);
  await page.goto(opts.baseUrl + SEL.imagePagePath, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await dismissPopups(page);

  const fileInput = page.locator(SEL.fileInput[0]).first();
  await fileInput.waitFor({ state: 'attached', timeout: 20000 });

  for (let i = 0; i < group.images.length; i++) {
    const img = group.images[i];
    log(`${tag}：上传 ${i + 1}/${group.images.length} ${path.basename(img)}`);
    // 用 buffer 方式上传：直接传中文路径时 Chromium 会静默丢弃、不触发 change 事件
    await fileInput.setInputFiles(filePayload(img));
    await waitUploadsSettle(page);
  }

  const titleInput = await firstVisible(page, SEL.titleInput, 3000);
  if (!titleInput) throw new Error('找不到标题输入框，请用 --inspect 查看页面并调整 SEL.titleInput');
  await titleInput.fill('');
  await titleInput.fill(group.title);

  const btn = await firstVisible(page, SEL.generateButton, 3000);
  if (!btn) throw new Error('找不到“生成二维码”按钮，请用 --inspect 查看页面并调整 SEL.generateButton');
  log(`${tag}：点击生成…`);
  await btn.click();

  // 等二维码出现
  let qr = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !qr) {
    qr = await firstVisible(page, SEL.qrImage, 800);
  }
  if (!qr) throw new Error('生成后没有找到二维码图片，请用 --inspect 查看结果页并调整 SEL.qrImage');
  await sleep(800);

  const outFile = path.join(opts.out, sanitizeFilename(group.title) + '.png');
  let saved = false;

  // 方式一：点“下载”按钮拿原图
  try {
    const dl = await firstVisible(page, SEL.downloadButton, 1500);
    if (dl) {
      const waitDownload = page.waitForEvent('download', { timeout: 8000 });
      await dl.click();
      const fmt = await firstVisible(page, SEL.downloadFormat, 1200);
      if (fmt) await fmt.click().catch(() => {});
      const download = await waitDownload;
      await download.saveAs(outFile);
      saved = fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
    }
  } catch (_) {
    saved = false;
  }
  // 方式二：直接截二维码元素
  if (!saved) {
    await qr.screenshot({ path: outFile });
    saved = true;
    log(`${tag}：未能通过下载按钮取图，已改为截取二维码元素`);
  }

  const html = await page.content();
  const short = (html.match(SHORT_URL_RE) || [])[0] || '';
  const pageShot = path.join(opts.out, sanitizeFilename(group.title) + '.页面.png');
  await page.screenshot({ path: pageShot, fullPage: true }).catch(() => {});

  log(`${tag}：完成 → ${outFile}${short ? `（${short}）` : ''}`);
  return { title: group.title, folder: group.name, images: group.images.length, shortUrl: short, pageUrl: page.url(), file: outFile };
}

async function doGenerate(pw, opts, groups) {
  const { browser, context } = await openContext(pw, opts);
  const page = await context.newPage();
  const results = [];
  try {
    await page.goto(opts.baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await dismissPopups(page);
    if (!opts.skipLoginCheck && !(await isLoggedIn(page))) {
      throw new Error('当前未登录草料账号。请先执行 `node caoliao-qr/make_qr.cjs --login`，或提供 --cookie / CAOLIAO_COOKIE。');
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      try {
        results.push(await createOne(page, g, opts, i + 1, groups.length));
      } catch (e) {
        warn(`${g.title} 失败：${e.message}`);
        const shot = path.join(opts.out, sanitizeFilename(g.title) + '.失败.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        results.push({ title: g.title, folder: g.name, images: g.images.length, error: e.message, screenshot: shot });
        if (opts.failFast) throw e;
      }
    }
  } finally {
    // 生成过程中登录态可能被刷新，顺手保存
    if (!opts.cookie && !process.env.CAOLIAO_STORAGE_STATE_B64) {
      await context.storageState({ path: opts.state }).catch(() => {});
    }
    await browser.close();
  }
  return results;
}

function writeResults(opts, results) {
  const jsonPath = path.join(opts.out, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const lines = ['| 标题 | 图片数 | 短链接 | 二维码文件 | 状态 |', '| --- | --- | --- | --- | --- |'];
  for (const r of results) {
    lines.push(`| ${r.title} | ${r.images} | ${r.shortUrl || ''} | ${r.file ? path.basename(r.file) : ''} | ${r.error ? '失败：' + r.error : '成功'} |`);
  }
  const mdPath = path.join(opts.out, '结果.md');
  fs.writeFileSync(mdPath, lines.join('\n') + '\n');
  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();

  // 无人值守时的总闸：超过时限直接退出，避免卡死
  const watchdogMin = Number(args.timeout || process.env.CAOLIAO_TIMEOUT_MIN || 30);
  setTimeout(() => {
    console.error(`[草料][错误] 超过 ${watchdogMin} 分钟仍未完成，强制退出`);
    process.exit(3);
  }, watchdogMin * 60 * 1000).unref();

  const opts = {
    baseUrl: (args['base-url'] || process.env.CAOLIAO_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    out: path.resolve(args.out || path.join(HERE, 'output')),
    state: path.resolve(args.state || process.env.CAOLIAO_STORAGE_STATE || path.join(HERE, 'state', 'caoliao-state.json')),
    cookie: args.cookie || process.env.CAOLIAO_COOKIE || '',
    headed: !!args.headed,
    dryRun: !!args['dry-run'],
    skipLoginCheck: !!args['skip-login-check'],
    failFast: !!args['fail-fast'],
    titleMode: args['title-mode'] || 'chinese',
    loginTimeout: args['login-timeout'],
    workDir: args.work ? path.resolve(args.work) : '',
  };
  ensureDir(opts.out);

  if (args.login || args.inspect) {
    const pw = loadPlaywright();
    if (args.login) await doLogin(pw, opts);
    if (args.inspect) await doInspect(pw, opts);
    return;
  }

  const input = args._[0];
  if (!input) {
    usage();
    throw new Error('请提供 zip 文件或文件夹路径');
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) throw new Error(`找不到：${inputPath}`);

  let rootDir = inputPath;
  if (fs.statSync(inputPath).isFile()) {
    const work = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'caoliao-'));
    log(`解压 ${path.basename(inputPath)} → ${work}`);
    extractZip(inputPath, work);
    rootDir = work;
  }

  const { root, groups } = collectGroups(rootDir, opts.titleMode);
  if (!groups.length) throw new Error(`在 ${root} 里没有找到图片（支持 ${Array.from(IMAGE_EXT).join(' ')}）`);

  log(`共 ${groups.length} 个码：`);
  for (const g of groups) {
    log(`  · 标题「${g.title}」 ← ${g.name}（${g.images.length} 张：${g.images.map((p) => path.basename(p)).join('、')}）`);
  }
  if (opts.dryRun) {
    const plan = groups.map((g) => ({ title: g.title, folder: g.name, images: g.images }));
    const planPath = path.join(opts.out, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    log(`--dry-run：不联网。分组计划已写入 ${planPath}`);
    return;
  }

  const pw = loadPlaywright();
  const results = await doGenerate(pw, opts, groups);
  const { mdPath } = writeResults(opts, results);
  const ok = results.filter((r) => !r.error).length;
  log(`完成：成功 ${ok}/${results.length}，结果表 ${mdPath}`);
  for (const r of results) {
    if (!r.error) log(`  ✔ ${r.title} → ${r.file}${r.shortUrl ? '  ' + r.shortUrl : ''}`);
    else log(`  ✘ ${r.title}：${r.error}`);
  }
  if (ok < results.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error('[草料][错误]', e.message);
  process.exitCode = 1;
});

'use strict';
// 本地模拟的“草料图片码”页面，用来离线验证 make_qr.cjs 的操作流程：
//   /img       上传图片 + 标题 + 生成二维码 + 下载
//   /login     4 秒后自动“扫码登录”（种下 mock_login cookie）
//   /api/records  返回已生成的记录（测试用）
const http = require('http');
const { URL } = require('url');
const { makePng } = require('./png.cjs');

const QR_PNG = makePng(200, 200, [255, 255, 255], 20);
const records = [];
const uploads = [];

function loggedIn(req) {
  return /(?:^|;\s*)mock_login=1/.test(req.headers.cookie || '');
}

function page(req, body, title = '草料二维码 · 模拟') {
  const nav = loggedIn(req)
    ? '<a href="/mine">我的二维码</a> <span class="user-name">测试用户</span> <a href="/logout">退出登录</a>'
    : '<a href="/login">登录</a> <a href="/register">注册</a>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><header>${nav}</header>${body}</body></html>`;
}

const IMG_PAGE = `
<h1>图片二维码</h1>
<div id="uploader">
  <input type="file" id="file" accept="image/*" multiple>
  <ul id="thumbs"></ul>
  <span id="status"></span>
</div>
<input id="title" placeholder="请输入标题">
<button id="gen">生成二维码</button>
<div id="result" style="display:none">
  <p>短网址：<span id="short"></span></p>
  <img id="qr" class="qrcode-img" alt="qr">
  <div><button id="dl">下载</button><span id="fmt" style="display:none"><a id="png-link">PNG</a></span></div>
</div>
<script>
  const files = [];
  document.getElementById('file').addEventListener('change', async (e) => {
    const st = document.getElementById('status');
    for (const f of e.target.files) {
      st.textContent = '上传中…';
      await new Promise(r => setTimeout(r, 400));
      const fd = new FormData(); fd.append('file', f);
      await fetch('/api/upload', { method: 'POST', body: fd });
      files.push(f.name);
      const li = document.createElement('li'); li.className = 'thumb'; li.textContent = f.name;
      document.getElementById('thumbs').appendChild(li);
    }
    st.textContent = '';
    e.target.value = '';
  });
  document.getElementById('gen').addEventListener('click', async () => {
    const title = document.getElementById('title').value.trim();
    if (!title) { alert('请填写标题'); return; }
    if (!files.length) { alert('请上传图片'); return; }
    const res = await fetch('/api/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, files }) });
    const data = await res.json();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('short').textContent = data.shortUrl;
    document.getElementById('qr').src = '/qr/' + data.id + '.png';
    document.getElementById('result').style.display = 'block';
    document.getElementById('dl').onclick = () => { document.getElementById('fmt').style.display = 'inline'; };
    document.getElementById('png-link').onclick = () => { location.href = '/download/' + data.id + '.png'; };
  });
</script>`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function start(port = 8765) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (u.pathname === '/' || u.pathname === '/img') return send(200, page(req, IMG_PAGE));
    if (u.pathname === '/login') {
      if (loggedIn(req)) return send(302, '', { location: '/img' });
      return send(200, page(req, `<h1>登录</h1><img id="wx" src="/qr/login.png" alt="微信扫码登录"><p>请使用微信扫码</p>
<script>setTimeout(() => { document.cookie = 'mock_login=1; path=/'; location.href = '/img'; }, 4000);</script>`, '登录 - 模拟'));
    }
    if (u.pathname.startsWith('/qr/')) return send(200, QR_PNG, { 'content-type': 'image/png' });
    if (u.pathname.startsWith('/download/')) {
      return send(200, QR_PNG, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="qrcode.png"' });
    }
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const m = body.toString('latin1').match(/filename="([^"]*)"/);
      uploads.push({ name: m ? Buffer.from(m[1], 'latin1').toString('utf8') : '?', bytes: body.length, at: Date.now() });
      return send(200, '{"ok":true}', { 'content-type': 'application/json' });
    }
    if (u.pathname === '/api/create' && req.method === 'POST') {
      const data = JSON.parse((await readBody(req)).toString('utf8'));
      const id = 'm' + (records.length + 1);
      const rec = { id, title: data.title, files: data.files, shortUrl: `https://qr71.cn/mock/${id}Abc`, loggedIn: loggedIn(req) };
      records.push(rec);
      return send(200, JSON.stringify(rec), { 'content-type': 'application/json' });
    }
    if (u.pathname === '/api/records') return send(200, JSON.stringify({ records, uploads }), { 'content-type': 'application/json' });
    send(404, 'not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || 8765);
  start(port).then(() => console.log(`mock site on http://127.0.0.1:${port}`));
}

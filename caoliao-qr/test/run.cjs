'use strict';
// 离线自测：示例 zip → dry-run → 模拟站点登录 → 生成 → 校验产物。
//   node caoliao-qr/test/run.cjs
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { makeSample } = require('./make-sample.cjs');

const SCRIPT = path.join(__dirname, '..', 'make_qr.cjs');
const TMP = path.join(__dirname, 'tmp');
const PORT = 8765 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}

function run(args, env = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    // agent:false —— 避免复用被服务器超时关闭的 keep-alive 连接导致 socket hang up
    http.get(url, { agent: false }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(JSON.parse(s)));
    }).on('error', reject);
  });
}

async function waitReady(url, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await getJson(url);
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('模拟站点未启动');
}

function isPng(file) {
  const b = fs.readFileSync(file);
  return b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG';
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const { zipPath } = makeSample(TMP);
  const expectTitles = ['施工器具检测报告-鼓风机', '发电机'];

  // 1. dry-run：分组与标题
  console.log('\n=== 1. dry-run ===');
  let r = run([zipPath, '--dry-run', '--out', path.join(TMP, 'out-dry')]);
  assert(r.status === 0, 'dry-run 退出码应为 0');
  const plan = JSON.parse(fs.readFileSync(path.join(TMP, 'out-dry', 'plan.json'), 'utf8'));
  assert(plan.length === 2, '应识别出 2 个码，实际 ' + plan.length);
  assert(JSON.stringify(plan.map((p) => p.title).sort()) === JSON.stringify([...expectTitles].sort()), '标题应为中文部分：' + plan.map((p) => p.title));
  for (const p of plan) {
    assert(p.images.length === 2, `${p.title} 应有 2 张图`);
    assert(path.basename(p.images[0]).endsWith('_01.png') && path.basename(p.images[1]).endsWith('_02.png'), '图片应按 _01、_02 顺序');
  }

  // 模拟站点必须跑在独立进程里：spawnSync 会阻塞本进程的事件循环
  const server = spawn('node', [path.join(__dirname, 'mock-site.cjs'), String(PORT)], { stdio: 'inherit' });
  await waitReady(BASE + '/api/records');
  try {
    // 2. 未登录应报错
    console.log('\n=== 2. 未登录检查 ===');
    r = run([zipPath, '--base-url', BASE, '--out', path.join(TMP, 'out-nologin'), '--state', path.join(TMP, 'none.json')]);
    assert(r.status !== 0 && /未登录/.test(r.stderr + r.stdout), '未登录时应提示先登录');

    // 3. 无界面登录：截图轮询直到登录成功，保存 state
    console.log('\n=== 3. --login ===');
    const state = path.join(TMP, 'state.json');
    r = run(['--login', '--base-url', BASE, '--state', state, '--out', path.join(TMP, 'out-login'), '--login-timeout', '60']);
    assert(r.status === 0, '--login 应成功');
    assert(fs.existsSync(state) && /mock_login/.test(fs.readFileSync(state, 'utf8')), 'state 文件应包含登录 cookie');
    assert(fs.existsSync(path.join(TMP, 'out-login', 'login-screen.png')), '应生成登录页截图');
    assert(fs.existsSync(state + '.b64'), '应生成 base64 版本');

    // 4. 用保存的 state 生成
    console.log('\n=== 4. 生成（state 登录态） ===');
    const out = path.join(TMP, 'out');
    r = run([zipPath, '--base-url', BASE, '--state', state, '--out', out]);
    assert(r.status === 0, '生成应成功，退出码 ' + r.status);
    const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert(results.length === 2 && results.every((x) => !x.error), '两个码都应成功：' + JSON.stringify(results));
    for (const x of results) {
      assert(fs.existsSync(x.file) && isPng(x.file), `${x.title} 应产出 PNG`);
      assert(path.basename(x.file) === x.title + '.png', '文件名应等于标题');
      assert(/^https:\/\/qr71\.cn\/mock\//.test(x.shortUrl), '应抓到短链接');
      assert(x.images === 2, '每个码 2 张图');
    }
    assert(fs.existsSync(path.join(out, '结果.md')), '应生成结果.md');
    const srv = await getJson(BASE + '/api/records');
    assert(srv.records.length === 2, '模拟站点应收到 2 次生成');
    assert(JSON.stringify(srv.records.map((x) => x.title).sort()) === JSON.stringify([...expectTitles].sort()), '站点收到的标题应正确');
    assert(srv.records.every((x) => x.files.length === 2 && x.loggedIn), '每次生成应带 2 张图且处于登录态');
    assert(srv.uploads.length === 4, '应为逐张上传，共 4 次上传请求，实际 ' + srv.uploads.length);
    for (const rec of srv.records) {
      assert(rec.files[0].endsWith('_01.png') && rec.files[1].endsWith('_02.png'), '上传顺序应为 _01 → _02');
    }

    // 5. 用 --cookie 生成（不依赖 state 文件）
    console.log('\n=== 5. 生成（cookie 登录态） ===');
    const out2 = path.join(TMP, 'out-cookie');
    r = run([zipPath, '--base-url', BASE, '--state', path.join(TMP, 'none.json'), '--out', out2, '--cookie', 'mock_login=1; other=x']);
    assert(r.status === 0, 'cookie 方式应成功');
    const results2 = JSON.parse(fs.readFileSync(path.join(out2, 'results.json'), 'utf8'));
    assert(results2.length === 2 && results2.every((x) => !x.error), 'cookie 方式两个码都应成功');

    // 6. 用环境变量 CAOLIAO_STORAGE_STATE_B64
    console.log('\n=== 6. 生成（环境变量 base64 登录态） ===');
    const out3 = path.join(TMP, 'out-b64');
    r = run([zipPath, '--base-url', BASE, '--state', path.join(TMP, 'none.json'), '--out', out3], {
      CAOLIAO_STORAGE_STATE_B64: fs.readFileSync(state + '.b64', 'utf8'),
    });
    assert(r.status === 0, 'base64 环境变量方式应成功');

    // 7. --inspect
    console.log('\n=== 7. --inspect ===');
    r = run(['--inspect', '--base-url', BASE, '--state', state, '--out', path.join(TMP, 'out-inspect')]);
    assert(r.status === 0, '--inspect 应成功');
    const info = JSON.parse(fs.readFileSync(path.join(TMP, 'out-inspect', 'inspect.json'), 'utf8'));
    assert(info.buttons.some((b) => b.text === '生成二维码') && info.inputs.some((i) => i.placeholder === '请输入标题'), 'inspect 应导出按钮与输入框');

    console.log('\n全部通过 ✔');
  } finally {
    server.kill();
  }
})().catch((e) => {
  console.error('\n测试失败：', e.message);
  process.exit(1);
});

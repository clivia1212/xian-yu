'use strict';
// 生成与截图一致的示例目录并打成 zip：
//   检测报告 (1)/5.6-发电机/5.6-发电机_01.png, _02.png
//   检测报告 (1)/5.11-施工器具检测报告-鼓风机/5.11-施工器具检测报告-鼓风机_01.png, _02.png
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makePng } = require('./png.cjs');

function makeSample(tmpDir) {
  const rootName = '检测报告 (1)';
  const root = path.join(tmpDir, rootName);
  fs.rmSync(root, { recursive: true, force: true });
  const folders = ['5.6-发电机', '5.11-施工器具检测报告-鼓风机'];
  folders.forEach((f, fi) => {
    const dir = path.join(root, f);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 2; i++) {
      const rgb = [200 + fi * 20, 120 + i * 40, 80];
      fs.writeFileSync(path.join(dir, `${f}_0${i}.png`), makePng(120, 160, rgb, 0));
    }
  });
  // 混入 macOS 常见的垃圾文件，脚本应忽略
  fs.writeFileSync(path.join(root, '.DS_Store'), Buffer.alloc(8));
  const zipPath = path.join(tmpDir, rootName + '.zip');
  fs.rmSync(zipPath, { force: true });
  const py = `
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(root)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, base))
`;
  const r = spawnSync('python3', ['-c', py, root, zipPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('打包示例 zip 失败：' + r.stderr);
  return { root, zipPath, folders };
}

module.exports = { makeSample };

if (require.main === module) {
  const tmp = path.resolve(process.argv[2] || path.join(__dirname, 'tmp'));
  fs.mkdirSync(tmp, { recursive: true });
  const { zipPath } = makeSample(tmp);
  console.log(zipPath);
}

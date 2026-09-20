---
name: caoliao-qr
description: 用户丢来检测报告 zip（或图片文件夹）要“生成码/二维码/草料码”时使用。每个子文件夹一份报告，一份报告一个草料图片码：图片逐张上传、标题取文件名中文部分、返回二维码图片让用户扫码确认。
---

# 检测报告 zip → 草料图片码

工具在 `caoliao-qr/make_qr.cjs`，说明在 `caoliao-qr/README.md`。整个流程不需要再向用户确认，直接做完把二维码图发回去。

## 步骤

1. **找到输入**：用户消息里的 zip/文件夹路径；如果是附件，在会话目录（`/tmp/claude-0/…`、`~/`、当前目录）里 `find -name "*.zip"` 找最新的。
2. **检查网络**：`curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://cli.im/`。
   返回 000 且 `curl -sS "$HTTPS_PROXY/__agentproxy/status"` 里出现 `connect_rejected`，说明云端环境网络策略拦截了草料，
   **不要重试**，告诉用户：在环境设置里把网络改为不限制或放行 `cli.im *.cli.im api.2dcode.biz qr71.cn *.aliyuncs.com`，然后结束。
3. **先看分组**：`node caoliao-qr/make_qr.cjs "<zip>" --dry-run`，确认识别出的码数、标题（中文部分）、每个码的图片顺序正常。
4. **登录态**：按顺序检查环境变量 `CAOLIAO_COOKIE`、`CAOLIAO_STORAGE_STATE_B64`、文件 `caoliao-qr/state/caoliao-state.json`。
   都没有就执行 `node caoliao-qr/make_qr.cjs --login`（后台运行），把 `caoliao-qr/output/login-screen.png` 用 SendUserFile 发给用户，
   请用户用微信扫图里的二维码；脚本检测到登录后会自动保存登录态。登录后提醒用户把 `caoliao-qr/state/caoliao-state.json.b64` 的内容
   设为环境变量 `CAOLIAO_STORAGE_STATE_B64`，下次不用再扫。
5. **生成**：`node caoliao-qr/make_qr.cjs "<zip>"`。产物在 `caoliao-qr/output/`。
6. **交付**：把 `caoliao-qr/output/<标题>.png`（不含 `.页面.png`、`.失败.png`）逐个 SendUserFile 给用户，附上 `结果.md` 里的标题 / 图片数 / 短链接表，
   请用户扫码确认。

## 出错时

- 报“找不到标题输入框 / 生成按钮 / 二维码图片”：草料页面改版。执行 `node caoliao-qr/make_qr.cjs --inspect`，
  读 `caoliao-qr/output/inspect.json` 和 `inspect.png`，修改 `make_qr.cjs` 顶部 `SEL` 里对应的候选选择器，重跑，并把修好的选择器提交到仓库。
- 报“未登录”：登录态过期，回到第 4 步。
- 上传卡住：看 `$HTTPS_PROXY/__agentproxy/status` 的 `recentRelayFailures`，把被拒域名报给用户加白名单。
- 改动脚本后先跑离线自测 `node caoliao-qr/test/run.cjs`，全部通过再提交。

## 不要做的事

- 不要把 `caoliao-qr/output/`、`caoliao-qr/state/` 提交到仓库（已在 .gitignore）。
- 不要在网络被策略拦截时反复重试或换域名绕行。

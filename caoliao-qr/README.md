# 草料图片码一键生成

把一个 **检测报告 zip** 丢进来，自动在草料二维码（cli.im）里为每份报告建一个「图片码」：
图片逐张上传、码标题取文件名的中文部分、把生成的二维码图片存下来，扫一下就能核对。

```
检测报告 (1).zip
└── 检测报告 (1)
    ├── 5.6-发电机                       → 码标题「发电机」
    │   ├── 5.6-发电机_01.png              （第 1 张）
    │   └── 5.6-发电机_02.png              （第 2 张）
    └── 5.11-施工器具检测报告-鼓风机     → 码标题「施工器具检测报告-鼓风机」
        ├── 5.11-施工器具检测报告-鼓风机_01.png
        └── 5.11-施工器具检测报告-鼓风机_02.png
```

规则：

- **一个子文件夹 = 一个码**，文件夹里的图片按 `_01、_02…` 顺序逐张上传。
- 图片直接放在根目录时，按去掉 `_01`/`-1`/`(1)` 后缀的文件名分组。
- **标题 = 名字里的中文部分**（第一个汉字到最后一个汉字，中间的 `-` 保留）。
  想用完整文件夹名当标题加 `--title-mode full`。
- 产物在 `caoliao-qr/output/`：`<标题>.png`（二维码）、`结果.md`（标题 / 图片数 / 短链接）、`results.json`。

## 用法

```bash
node caoliao-qr/make_qr.cjs "检测报告 (1).zip"              # 正式生成
node caoliao-qr/make_qr.cjs "检测报告 (1).zip" --dry-run    # 只看分组和标题，不联网
node caoliao-qr/make_qr.cjs --login                         # 登录一次并保存登录态
node caoliao-qr/make_qr.cjs --inspect                       # 导出页面按钮/输入框，改选择器用
node caoliao-qr/test/run.cjs                                # 离线自测（用本地模拟站点）
```

常用参数：`--out 目录`、`--state 登录态文件`、`--cookie "k=v; …"`、`--headed`（本机弹出浏览器）、
`--base-url`（默认 https://cli.im）、`--skip-login-check`、`--fail-fast`、`--timeout 分钟`（默认 30，超时强制退出）。

依赖：Node ≥ 18、Playwright（`npm i -g playwright && npx playwright install chromium`）、python3（解压中文文件名用，没有会退回系统 unzip）。
Claude Code 云端环境已自带 Playwright 与 Chromium，不用安装。

## 登录态（只需准备一次）

生成图片码要登录草料账号，脚本按下面顺序找登录态：

1. `--cookie` 参数或环境变量 `CAOLIAO_COOKIE`：在已登录草料的浏览器里
   打开开发者工具 → Network → 任意 cli.im 请求 → 复制 Request Headers 里的 `Cookie` 整串。
2. 环境变量 `CAOLIAO_STORAGE_STATE_B64`：`--login` 成功后会生成 `state/caoliao-state.json.b64`，
   把它的内容设成这个环境变量，云端环境每次开新会话都能直接用。
3. `state/caoliao-state.json` 文件：本机用 `--login --headed` 弹出浏览器登录后自动保存。

云端（无界面）执行 `--login` 时，脚本会把登录页截图持续刷新到 `output/login-screen.png`，
用微信扫截图里的二维码即可，登录成功后自动保存登录态。

`state/`、`output/` 都在 `.gitignore` 里，登录态不要提交到仓库。

## 在 Claude Code 云端环境使用前：放行网络

云端环境默认的网络策略拦截了草料相关域名（curl 会报 `CONNECT tunnel failed, response 403`）。
需要在环境设置里把网络访问改为不限制，或者至少放行：

```
cli.im  *.cli.im  open-api.cli.im  api.2dcode.biz  qr71.cn  qr61.cn  qr02.cn  *.aliyuncs.com
```

草料上传图片走的 CDN/对象存储域名可能不止这些；首次运行如果卡在上传，
执行 `curl -sS "$HTTPS_PROXY/__agentproxy/status"` 看 `recentRelayFailures` 里被拒的域名，一并加进白名单。

## 草料改版了怎么办

页面元素的选择器集中在 `make_qr.cjs` 顶部的 `SEL` 对象里，都是候选列表，脚本会依次尝试。
执行 `--inspect` 会把当前页面上可见的按钮、输入框、占位符、图片导出到 `output/inspect.json` 并截图，
对照着改 `SEL` 即可。生成失败的码会留下 `<标题>.失败.png` 的整页截图方便排查。

## 备选方案：草料开放平台 API

草料有官方开放接口（https://cli.im/open-api/ ，批量活码接口
`https://open-api.cli.im/cli-open-platform-service/v1/dynamicQrcode/dynamicSingleCreate`，
需要在账号里开通并获取 API key / secret，MD5 加签）。目前文档里没有看到带图片上传的「图片码」创建接口，
所以本工具走的是网页自动化；如果账号开通了 API 且支持图片码，可以改用接口，会更稳定。

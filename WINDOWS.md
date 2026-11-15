# Windows 便携包

适用于 Windows 10 / 11 x64。包内包含 Node.js 24.22.3、程序依赖和 OKX OnchainOS 4.6.10，不需要另外安装 Node、npm 或钱包 CLI。这是解压运行的便携包，入口为 `启动.cmd`，不是安装程序。

## 下载和使用

**[下载 Windows x64 ZIP](https://github.com/goodperson888/TG-CopyTrading/releases/latest/download/TGCopyTrading-Windows-x64.zip)** · [版本页面 / SHA-256 校验](https://github.com/goodperson888/TG-CopyTrading/releases/latest)

公开下载，无需登录 GitHub。下载 ZIP 后解压一次，整个 `TGCopyTrading` 文件夹一起保留，可放在 `C:\TGCopyTrading`；不要在压缩包预览中直接运行。

1. 双击 `启动.cmd`，浏览器自动打开本机控制台，终端窗口需保持运行。首次默认为纸上模式，新买入暂停。
2. 打开网页 **策略与连接 → 本机 API 配置**，填入自己的 API Key、Secret、Passphrase，有 Project ID 再填。点击“保存到本机”后立即生效，再点“测试 API 连接”检查 SOL / BSC 只读报价。留空保留原值，保存后输入框清空、不回显密钥。填好资金和止盈止损等规则后点“启动纸上跟单”。
3. 实盘另需在 Windows 本机连接独立跟单钱包，并在官方页面设置自动交易及限额。已有浏览器插件钱包连接不会代替这项授权。SOL 使用 USDC 和 SOL 网络费，BSC 使用 USDT 和 BNB 网络费。
4. 停止新买入用网页按钮；完全停止用 `停止.cmd`，或者在启动窗口按 Ctrl+C。完全停止不会自动卖出，止盈止损也停止。关闭网页不会关闭后台。

`.env` 示例字段：

```dotenv
OKX_API_KEY=
OKX_API_SECRET=
OKX_API_PASSPHRASE=
OKX_PROJECT_ID=
OUTBOUND_PROXY=
PORT=8765
```

网页配置仅处理上方四项 OKX API 凭证，并保留代理、端口、RPC 等其他配置值。网络等高级字段可用 `配置.cmd` 在记事本中编辑当前文件夹的 `.env`；手动修改后先停止、再启动，不要另存为 `.env.txt`。源码和 GitHub 通用包只包含空白 `.env.example`，不会带开发者的 Key。

每位用户申请自己的开发者 API 凭证；API Key、Secret 和 Passphrase 不可随公开客户端共用。共享密钥会暴露给客户端用户并共用配额及账户权限。钱包登录也由各用户自行完成，程序不索要私钥或助记词。配置和数据只存本机，分发给别人时请发送 Releases 通用 ZIP。

## 仅本机配置版

在已经配置好凭证的 macOS 或 Windows 开发机上执行 `npm run build:win:private`，生成 `private-builds/TGCopyTrading-Windows-x64-本机配置.zip`。其中预填本机 `.env`，并只导出策略设置；不带钱包会话、持仓或历史订单。Windows 首次启动以纸上模式导入策略，新买入暂停；尚未填写的参数仍需补齐。已有 Windows 数据库的设置不会被快照覆盖。

此包含 API 凭证，只供本人保管和传输，不上传仓库、Actions 或公开下载。构建脚本在 GitHub Actions 环境中禁止生成配置版。`ONCHAINOS_BIN` 自动清空以使用内置 Windows 组件；其他配置保持原值。换电脑后若 API 有 IP 白名单，需要核对新电脑/代理的公网出口 IP。

## 网络和数据

程序优先使用 `.env` 的 `OUTBOUND_PROXY`；空值时尝试读取 Windows 当前用户已启用的系统 HTTP/HTTPS 代理。不自动执行 PAC，不直接使用 SOCKS；必要时手填 HTTP CONNECT 地址，例如 `http://127.0.0.1:7890`，也可填 `direct` 强制直连。代理工具应先启动。

程序目录下的 `data` 保存本机记录和敏感钱包登录会话；保管整个目录，不能上传共享。Windows 文件访问权限取决于当前用户和 NTFS 权限，不以 macOS 的 0600/0700 权限位作为保证。不要把带配置/钱包数据的运行目录放进共享盘。运行期间电脑需保持联网和唤醒，Windows 不自动修改电源设置。

升级时先正常停止，解压新通用包到新文件夹；需要保留同一机器的数据时自行复制原 `.env` 和 `data`，不要覆盖它们或同时运行两个副本。跨电脑的钱包登录会话不随本机配置版迁移。

## 自动构建

推送 `main`、推送 `v*` 标签或在 Actions 手动运行，会在 Windows runner 上执行依赖安装、自动测试、语法检查、固定版本与 SHA-256 校验、打包、解压和实际启动/正常停止验收，再上传 zip 和校验文件。`v*` 标签在所有检查通过后自动创建公开 GitHub Release，提供固定文件名下载；普通分支构建仍只保存 Actions artifact。不会自动登录钱包或测试真实交易。

本地构建：`npm ci --ignore-scripts` 后运行 `npm run build:win`；Windows 可继续 `npm run verify:win`。macOS 能生成 Windows 包，但不能替代 Windows 实机运行验证。运行时和钱包组件版本/校验值固定在 `scripts/windows-runtime.json` 与 `scripts/wallet-release.json`。

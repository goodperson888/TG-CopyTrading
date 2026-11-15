#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    source "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  print '需要 Node.js 24 或更新版本。安装后再次打开本文件。'
  read '?按回车退出…'
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  print '当前 Node.js 版本过低，需要 24 或更新版本。'
  read '?按回车退出…'
  exit 1
fi
if [[ ! -d node_modules/linkedom || ! -d node_modules/undici ]]; then
  npm ci --ignore-scripts --no-fund
fi
exec node src/server.mjs --open

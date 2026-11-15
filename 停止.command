#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if command -v node >/dev/null 2>&1; then
  node scripts/stop.mjs
else
  print '未找到 Node.js，请在启动项目的终端按 Ctrl+C。'
fi
read '?按回车关闭此窗口…'

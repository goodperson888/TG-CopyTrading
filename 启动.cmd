@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo 未找到内置运行时，请先完整解压 Windows 便携包。
  pause
  exit /b 1
)
if not exist ".env" copy /y ".env.example" ".env" >nul
echo 如需填写或修改 Key，请双击“配置.cmd”，保存后重新启动。
"%~dp0runtime\node.exe" "%~dp0src\server.mjs" --open
echo 后台已退出。停止程序不会自动卖出已有持仓。
pause

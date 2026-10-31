@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动南医大评课助手（独立版）...
start "" http://127.0.0.1:17320
"%~dp0node\node.exe" "%~dp0server.mjs"
pause
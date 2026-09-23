@echo off
rem 看板一键启动：双击本文件即可。
rem 真正的逻辑在 cli\kanban.mjs（已在本项目的看板就不重复起、起完自动开浏览器）。
rem 本文件只留 ASCII —— 中文交给 node 打印，免得 cmd 的代码页把它变成乱码。
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found on PATH. Install Node 20+ first: https://nodejs.org
  pause
  exit /b 1
)

node cli\kanban.mjs %*
if errorlevel 1 (
  pause
) else (
  timeout /t 3 >nul
)

@echo off
rem Kanban one-click launcher -- double-click this file.
rem Real logic lives in cli\kanban.mjs:
rem   * this project's board already running -> just open the browser
rem   * port taken by something else          -> refuse and tell you to pick another
rem   * nobody there                          -> start the server in background,
rem                                             wait until it really answers
rem KEEP THIS FILE ASCII-ONLY. cmd.exe parses .cmd bytes in the OEM codepage and
rem ignores chcp while reading the file, so non-ASCII comments here break parsing
rem (observed 2026-09-23: Chinese "rem" lines mangled "if errorlevel" into "rorlevel").
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found on PATH. Install Node 20+ first: https://nodejs.org
  pause
  exit /b 1
)

node cli\kanban.mjs %*
if errorlevel 1 pause

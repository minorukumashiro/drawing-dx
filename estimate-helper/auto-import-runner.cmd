@echo off
rem 弥生元帳の自動取込ウォッチャー起動ラッパー（タスクスケジューラから呼ばれる）
rem auto-import.log が 5MB を超えていたら auto-import.log.old へ退避してから node を起動する
cd /d %~dp0
for %%A in (auto-import.log) do if %%~zA GTR 5242880 move /y auto-import.log auto-import.log.old >nul 2>&1
set NODE_EXE=C:\Program Files\nodejs\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node
"%NODE_EXE%" bin\auto-import.js >> auto-import.log 2>&1

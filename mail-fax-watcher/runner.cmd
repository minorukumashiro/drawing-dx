@echo off
rem 図面DX メール/FAXウォッチャー起動ラッパー（タスクスケジューラから呼ばれる）
rem run.log が 5MB を超えていたら run.log.old へ退避してから node を起動する
cd /d %~dp0
for %%A in (run.log) do if %%~zA GTR 5242880 move /y run.log run.log.old >nul 2>&1
set NODE_EXE=C:\Program Files\nodejs\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node
"%NODE_EXE%" index.js >> run.log 2>&1

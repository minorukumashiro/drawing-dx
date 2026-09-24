@echo off
rem Launcher for the Drawing DX mail/FAX watcher (called from Task Scheduler).
rem Rotates run.log to run.log.old once it exceeds 5MB, then starts node.
rem
rem Comments must stay ASCII-only. cmd.exe reads .cmd files in the system codepage
rem (CP932 here), so UTF-8 Japanese comments turn into mojibake AND swallow the
rem following line break, which merged lines 2-4 and killed both "cd /d" and the
rem log rotation below. See each README for the Japanese explanation.
cd /d %~dp0
for %%A in (run.log) do if %%~zA GTR 5242880 move /y run.log run.log.old >nul 2>&1
set NODE_EXE=C:\Program Files\nodejs\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node
"%NODE_EXE%" index.js >> run.log 2>&1
rem The task launches this through "conhost --headless" so no console window pops up,
rem and conhost does not pass the child exit code back to Task Scheduler (LastTaskResult
rem is always 0). Record a failure in the log instead, which is what we actually read.
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo [runner] node exited with code %RC% >> run.log
exit /b %RC%

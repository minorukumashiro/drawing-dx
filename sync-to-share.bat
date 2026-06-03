@echo off
copy /y "C:\Users\ths-4\Projects\drawing-dx\index.html" "\\ls220db63\share\index.html"
if %errorlevel% == 0 (
    echo [OK] Sync complete.
) else (
    echo [ERROR] Copy failed. Check network share connection.
)
pause

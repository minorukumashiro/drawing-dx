@echo off
copy /y "C:\Users\ths-4\Projects\drawing-dx\index.html" "\\ls220db63\share\index.html"
if %errorlevel% == 0 (
    echo [OK] index.html をネットワーク共有に同期しました
) else (
    echo [ERROR] コピー失敗。共有フォルダに接続できているか確認してください
)
pause

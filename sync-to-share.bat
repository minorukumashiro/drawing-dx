@echo off
rem 手元の index.html を NAS 共有へ即時反映する（手動実行用）。
rem コピー元は %~dp0 = このバッチが置かれているフォルダなので、
rem リポジトリごと別の場所へ移してもパスの直しは不要。
rem
rem 注意: 毎朝8時のタスク DrawingDX-IndexSync が GitHub の main から
rem 共有先を上書きするため、未コミットの変更をここで反映しても翌朝には戻る。
rem 恒久的に反映したい場合は commit & push しておくこと。
copy /y "%~dp0index.html" "\\ls220db63\share\index.html"
if %errorlevel% == 0 (
    echo [OK] Sync complete.
) else (
    echo [ERROR] Copy failed. Check network share connection.
)
pause

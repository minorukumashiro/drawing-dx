# ThisOutlookSession に書き込まれているコードを読み戻し、outlook-macro.txt と一致するか確認する。
# 読み取り専用（書き込みは行わない）。Outlookの再起動後に実行すれば、
# ディスク保存(VbaProject.OTM)後も内容が保持されているかの確認になる。
#
# 実行方法: このフォルダで
#   .\verify-outlook-macro.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$macroPath = Join-Path $scriptDir 'outlook-macro.txt'
$macroText = Get-Content -Path $macroPath -Raw -Encoding UTF8

try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
} catch {
  throw "起動中のOutlookが見つかりません。Outlookを起動してから再実行してください。"
}

$vbe = $outlook.VBE
$component = $null
foreach ($proj in $vbe.VBProjects) {
  foreach ($comp in $proj.VBComponents) {
    if ($comp.Name -eq 'ThisOutlookSession') { $component = $comp; break }
  }
  if ($component) { break }
}
if (-not $component) { throw "ThisOutlookSessionモジュールが見つかりませんでした。" }

$codeModule = $component.CodeModule
$lineCount = $codeModule.CountOfLines
$currentText = if ($lineCount -gt 0) { $codeModule.Lines(1, $lineCount) } else { "" }

$normalize = { param($s) ($s -replace "`r`n", "`n").Trim() }
Write-Host "現在のThisOutlookSession行数: $lineCount"

if ((& $normalize $currentText) -eq (& $normalize $macroText)) {
  Write-Host "✓ outlook-macro.txt と完全に一致しています。"
} else {
  Write-Warning "✗ 内容が一致しません。差分を確認してください。"
  $currentText | Set-Content -Path (Join-Path $scriptDir 'run.log.current-macro-dump.txt') -Encoding UTF8
  Write-Host "現在の内容を run.log.current-macro-dump.txt に書き出しました。"
}

# VbaProject.OTM のディスク上の更新時刻も参考表示（保存済みか目安になる）
$otm = Get-ChildItem -Path "$env:APPDATA\Microsoft\Outlook" -Filter '*.otm' -ErrorAction SilentlyContinue
if ($otm) {
  foreach ($f in $otm) {
    Write-Host "VBAプロジェクトファイル: $($f.FullName) (最終更新: $($f.LastWriteTime))"
  }
} else {
  Write-Host "VbaProject.otm が見つかりませんでした（未保存の可能性）。"
}

# outlook-macro.txt の内容を Outlook の VBAプロジェクト内 ThisOutlookSession モジュールへ
# COM経由で直接書き込む（クリップボード/キー入力に依存しない）。
#
# 事前条件: Outlookのトラストセンターで
#   「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」を有効にしておくこと。
#
# 実行方法: このフォルダで
#   .\inject-outlook-macro.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$macroPath = Join-Path $scriptDir 'outlook-macro.txt'
if (-not (Test-Path $macroPath)) { throw "outlook-macro.txt が見つかりません: $macroPath" }
$macroText = Get-Content -Path $macroPath -Raw -Encoding UTF8

# 起動中のOutlookに接続。無ければ新規起動して少し待つ。
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
  Write-Host "起動中のOutlookに接続しました。"
} catch {
  Write-Host "起動中のOutlookが見つからないため新規起動します..."
  $outlook = New-Object -ComObject Outlook.Application
  Start-Sleep -Seconds 3
}

try {
  $vbe = $outlook.VBE
} catch {
  Write-Error @"
VBAプロジェクトへのプログラムアクセスが許可されていません。
Outlookで以下を設定してから再実行してください:
  ファイル > オプション > トラストセンター > トラストセンターの設定 >
  マクロの設定 > 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」にチェック > OK > OK
"@
  exit 1
}

# ThisOutlookSession コンポーネントを全プロジェクトから探す
$component = $null
foreach ($proj in $vbe.VBProjects) {
  foreach ($comp in $proj.VBComponents) {
    if ($comp.Name -eq 'ThisOutlookSession') {
      $component = $comp
      break
    }
  }
  if ($component) { break }
}
if (-not $component) { throw "ThisOutlookSessionモジュールが見つかりませんでした。" }

$codeModule = $component.CodeModule
$beforeLines = $codeModule.CountOfLines
if ($beforeLines -gt 0) {
  $codeModule.DeleteLines(1, $beforeLines)
}
$codeModule.AddFromString($macroText)
$afterLines = $codeModule.CountOfLines

Write-Host "書き込み完了。既存 $beforeLines 行を削除 → 新規 $afterLines 行を書き込みました。"

# 直後の自己検証（メモリ上の内容を読み戻して比較）
$writtenText = $codeModule.Lines(1, $afterLines)
$normalize = { param($s) ($s -replace "`r`n", "`n").Trim() }
if ((& $normalize $writtenText) -eq (& $normalize $macroText)) {
  Write-Host "✓ 書き込み内容の一致を確認しました。"
} else {
  Write-Warning "✗ 書き込み内容が元ファイルと一致しません。手動確認をおすすめします。"
}

Write-Host ""
Write-Host "この時点ではメモリ上（実行中のOutlookセッション）に反映されただけです。"
Write-Host "ディスク上のVBAプロジェクト(VbaProject.OTM)に保存するには、Outlookを完全に終了してください。"
Write-Host "（ファイル > 終了。マウス操作のみでOK。次回Outlook起動時から自動保存済みの状態で動作します）"

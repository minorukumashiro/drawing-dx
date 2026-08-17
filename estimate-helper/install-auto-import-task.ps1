# 弥生元帳の自動取込ウォッチャー
# Windowsタスクスケジューラに「毎日・15分おき」の巡回タスクを登録する。
# 弥生でエクスポートしたファイルが更新されていなければ bin/auto-import.js は即座に何もせず
# 終了するため、短い間隔で起動しておいて問題ない（弥生は取引先1社ずつ同じファイル名に
# 上書きエクスポートするので、間隔が長いと連続エクスポートの取りこぼしが起きる）。
#
# 実行方法: このスクリプトがあるフォルダで PowerShell を開き
#   .\install-auto-import-task.ps1
# を実行する（管理者権限は不要。現在ログイン中ユーザーのタスクとして登録される）。
#
# 解除したい場合:
#   Unregister-ScheduledTask -TaskName 'DrawingDX-YayoiAutoImport' -Confirm:$false

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "node.exe が見つかりません。Node.jsをインストールしてから再実行してください。"
  exit 1
}
$logPath = Join-Path $scriptDir 'auto-import.log'
$taskName = 'DrawingDX-YayoiAutoImport'

# auto-import-runner.cmd 経由で起動（auto-import.log が5MB超なら .old へ退避するログローテーション付き）
$runnerPath = Join-Path $scriptDir 'auto-import-runner.cmd'
if (-not (Test-Path -LiteralPath $runnerPath)) {
  Write-Error "auto-import-runner.cmd が見つかりません: $runnerPath"
  exit 1
}
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$runnerPath`"`"" -WorkingDirectory $scriptDir

# "毎日 x 15分おき x 継続" の巡回トリガーを作る（mail-fax-watcher/install-task.ps1 と同じ組み立て方）
$repeatSeed = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date).Date
$trigger.Repetition = $repeatSeed.Repetition

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Write-Host "既存タスク '$taskName' を更新します。"
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '図面DXプラットフォーム: 弥生の元帳エクスポートを検知してyayoiRecordsへ自動取込' -RunLevel Limited | Out-Null

Write-Host "タスク '$taskName' を登録しました（15分おきに巡回。更新が無ければ何もせず終了）。"
Write-Host "ログ出力先: $logPath"
Write-Host "タスクスケジューラのGUIで 'DrawingDX-YayoiAutoImport' を確認できます。"

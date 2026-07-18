# 図面DXプラットフォーム メール/FAX自動取込ウォッチャー
# Windowsタスクスケジューラに「毎日・30分おき」の巡回タスクを登録する。
# 平日日中/平日夜間/休日での実際の実行間隔切り替えは index.js 内部が自己判定するため、
# タスク側は常に短い間隔(30分)で起動しておけばよい。
#
# 実行方法: このスクリプトがあるフォルダで PowerShell を開き
#   .\install-task.ps1
# を実行する（管理者権限は不要。現在ログイン中ユーザーのタスクとして登録される）。

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "node.exe が見つかりません。Node.jsをインストールしてから再実行してください。"
  exit 1
}
$nodeExe = $nodeCmd.Source
$logPath = Join-Path $scriptDir 'run.log'
$taskName = 'DrawingDX-MailFaxWatcher'

# runner.cmd 経由で起動（run.log が5MB超なら run.log.old へ退避するログローテーション付き）
$runnerPath = Join-Path $scriptDir 'runner.cmd'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$runnerPath`"`"" -WorkingDirectory $scriptDir

# "毎日 x 30分おき x 継続" の巡回トリガーを作る
$repeatSeed = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 1)
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date).Date
$trigger.Repetition = $repeatSeed.Repetition

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Write-Host "既存タスク '$taskName' を更新します。"
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '図面DXプラットフォーム: メール添付/FAX受信を「待機」ステータスへ自動取込' -RunLevel Limited | Out-Null

Write-Host "タスク '$taskName' を登録しました（30分おき・実際の巡回間隔はスクリプト内部で平日日中30分/平日夜間・休日祝日6時間に自己調整）。"
Write-Host "ログ出力先: $logPath"
Write-Host "タスクスケジューラのGUIで 'DrawingDX-MailFaxWatcher' を確認できます。"

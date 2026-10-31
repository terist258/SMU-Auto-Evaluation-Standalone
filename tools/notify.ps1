<#
  不依赖 DSH 的桌面提醒：弹一个置顶窗口，N 秒后自动关。

  计划任务在 DSH 没开的时候跑失败，光写日志没人看得到，所以用它兜底：
    powershell -File notify.ps1 -Title "南医大评课助手" -Message "今天评课失败：..." -Level error

  -Level error 红色，ok 绿色，warn 橙色；-Seconds 控制停留时长（默认 20 秒）。
#>
param(
  [string]$Title = "南医大评课助手",
  [string]$Message = "",
  [ValidateSet("error", "ok", "warn", "info")]
  [string]$Level = "error",
  [int]$Seconds = 20
)

$ErrorActionPreference = "Stop"

# 有些调用方（Start-Process -ArgumentList）不会给参数加引号，
# 中文消息会被空格拆成多段落到 $args 里，这里拼回去。
if ($args -and $args.Count -gt 0) {
  $Message = (($Message + " " + ($args -join " ")) -replace "\s+", " ").Trim()
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ForceShow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$palette = @{
  error = @{ Back = "#B42318"; Edge = "#F04438"; Icon = "✕" }
  ok    = @{ Back = "#067647"; Edge = "#12B76A"; Icon = "✓" }
  warn  = @{ Back = "#B54708"; Edge = "#F79009"; Icon = "!" }
  info  = @{ Back = "#175CD3"; Edge = "#2E90FA"; Icon = "i" }
}
$c = $palette[$Level]

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.FormBorderStyle = "None"
$form.StartPosition = "Manual"
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c.Back)
$form.Width = 620
$form.Height = 210

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.Width - $form.Width - 40
$form.Top = $screen.Height - $form.Height - 40

$icon = New-Object System.Windows.Forms.Label
$icon.Text = $c.Icon
$icon.Font = New-Object System.Drawing.Font("Segoe UI", 30, [System.Drawing.FontStyle]::Bold)
$icon.ForeColor = [System.Drawing.Color]::White
$icon.AutoSize = $false
$icon.TextAlign = "MiddleCenter"
$icon.SetBounds(18, 30, 70, 70)
$form.Controls.Add($icon)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $Title
$lblTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Bold)
$lblTitle.ForeColor = [System.Drawing.Color]::White
$lblTitle.AutoSize = $false
$lblTitle.SetBounds(100, 26, $form.Width - 130, 34)
$form.Controls.Add($lblTitle)

$body = New-Object System.Windows.Forms.Label
$body.Text = $Message
$body.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11)
$body.ForeColor = [System.Drawing.Color]::White
$body.AutoSize = $false
$body.SetBounds(102, 66, $form.Width - 140, 100)
$form.Controls.Add($body)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "点任意位置关闭 · " + $Seconds + " 秒后自动消失"
$hint.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
$hint.ForeColor = [System.Drawing.Color]::FromArgb(210, 255, 255, 255)
$hint.AutoSize = $false
$hint.SetBounds(104, 168, $form.Width - 140, 24)
$form.Controls.Add($hint)

$form.Add_Click({ $form.Close() })
$icon.Add_Click({ $form.Close() })
$lblTitle.Add_Click({ $form.Close() })
$body.Add_Click({ $form.Close() })
$hint.Add_Click({ $form.Close() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(2000, $Seconds * 1000)
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$form.Add_Shown({
  # detached 启动时进程初始 show state 是 SW_HIDE，窗体"存在但看不见"，
  # 所以这里显式 ShowWindow(SW_SHOW) + 抢前台。
  try {
    [ForceShow]::ShowWindow($form.Handle, 5) | Out-Null
    [ForceShow]::SetForegroundWindow($form.Handle) | Out-Null
    $form.Activate()
    $form.BringToFront()
  } catch {}
  $timer.Start()
})

# 提醒音：选对级别，别用系统报错音吓人
try {
  if ($Level -eq "error") { [System.Media.SystemSounds]::Hand.Play() } else { [System.Media.SystemSounds]::Asterisk.Play() }
} catch {}

[void]$form.ShowDialog()

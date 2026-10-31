<#
  从微信浮窗刷新教务系统 Token。

  链路：weixin:// 唤醒微信（没开就先启动并等你扫码登录）
        → 点左下角「手机」图标 → 浮窗面板弹出
        → PrintWindow 截图 + 系统 OCR 找到「教学服务平台系统」那一行（顺序会变，必须识图）
        → 点它 → 微信内置浏览器打开已登录页面 → OAuth 重跑 → 新 Token 写入 leveldb
        → 关掉内置浏览器窗口

  输出一行 JSON：
    {ok:true, matched:"教学服务平台系统", clickedX:234, clickedY:1205, closed:1, shot:"..."}
    {ok:false, error:"...", shot:"..."}

  不注入、不改微信、不加第三方库：只用 Windows API + 微信自己的 weixin:// 协议 + 系统 OCR。
#>
param(
  [string]$ShotDir = (Join-Path $env:LOCALAPPDATA "smueval-bot"),
  [string]$Keyword = "教学服务平台",
  [int]$WaitMs = 9000,
  [int]$LoginWaitSec = 180,
  [switch]$KeepWindow
)

$ErrorActionPreference = "Stop"

function Out-Json($obj) {
  $obj | ConvertTo-Json -Compress
}

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WxTk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }

  public static bool TopMost(IntPtr h, bool on) {
    return SetWindowPos(h, (IntPtr)(on ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004);
  }

  // 透明/合成窗口用 CopyFromScreen 会抓成全黑，必须让窗口自己渲染到 DC
  public static bool Capture(IntPtr hwnd, string path) {
    RECT r; GetWindowRect(hwnd, out r);
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(w, h)) {
      using (var g = System.Drawing.Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }

  // 浮窗面板：Qt 工具窗，宽 > 300 才算真正的面板（托盘小窗也是这个类）
  public static IntPtr Panel() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "Qt51514QWindowToolSaveBits" && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        if ((r.Right - r.Left) > 300) found = h;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 微信内置浏览器窗口（CEF），取面积最大的那个
  public static IntPtr Browser() {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_0") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try {
        if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName != "WeChatAppEx") return true;
      } catch { return true; }
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static bool CloseWindow(IntPtr h) {
    return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);   // WM_CLOSE
  }
}
"@
[WxTk]::SetProcessDPIAware() | Out-Null

function Click([int]$x, [int]$y) {
  [WxTk]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 250
  [WxTk]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 90
  [WxTk]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}

function Activate-WeChat {
  for ($i = 0; $i -lt 3; $i++) {
    Start-Process -FilePath "weixin://" -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep -Milliseconds 1200
    if ([WxTk]::Title([WxTk]::GetForegroundWindow()) -eq "微信") { return $true }
  }
  return $false
}

New-Item -ItemType Directory -Force -Path $ShotDir | Out-Null
$stamp = Get-Date -Format "HHmmss"
$shot = Join-Path $ShotDir ("wechat-token-" + $stamp + ".png")

try {
  # ---- 1) 微信在不在；不在就启动 ----
  $wx = [WxTk]::FindWindow("Qt51514QWindowIcon", "微信")
  $started = $false
  if ($wx -eq [IntPtr]::Zero) {
    $exe = "C:\Program Files\Tencent\Weixin\Weixin.exe"
    if (-not (Test-Path $exe)) {
      $cand = Get-ChildItem "C:\Program Files\Tencent" -Recurse -Filter "Weixin.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($cand) { $exe = $cand.FullName }
    }
    if (-not (Test-Path $exe)) { Out-Json @{ ok = $false; error = "找不到微信客户端（Weixin.exe）" }; exit 0 }
    Start-Process -FilePath $exe -ErrorAction SilentlyContinue | Out-Null
    $started = $true
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      $wx = [WxTk]::FindWindow("Qt51514QWindowIcon", "微信")
      if ($wx -ne [IntPtr]::Zero) { break }
    }
  }
  if ($wx -eq [IntPtr]::Zero) { Out-Json @{ ok = $false; error = "微信启动后仍找不到主窗口" }; exit 0 }

  # ---- 2) 等登录态：能点出浮窗面板就说明登录好了 ----
  $deadline = (Get-Date).AddSeconds($LoginWaitSec)
  $panel = [IntPtr]::Zero
  $r = New-Object WxTk+RECT
  while ((Get-Date) -lt $deadline) {
    if (Activate-WeChat) {
      [WxTk]::ShowWindow($wx, 3) | Out-Null
      Start-Sleep -Milliseconds 600
      [WxTk]::GetWindowRect($wx, [ref]$r) | Out-Null
      $w = $r.Right - $r.Left
      $h = $r.Bottom - $r.Top
      $panel = [WxTk]::Panel()
      if ($panel -eq [IntPtr]::Zero) {
        Click ([int]($r.Left + $w * 0.0197)) ([int]($r.Top + $h * 0.929))
        Start-Sleep -Milliseconds 1800
        $panel = [WxTk]::Panel()
      }
      if ($panel -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Seconds 3
  }

  if ($panel -eq [IntPtr]::Zero) {
    Out-Json @{
      ok = $false
      error = ("等了 " + $LoginWaitSec + " 秒还是点不出浮窗面板：可能没登录（请在微信里扫码登录后再试）")
      needLogin = $true
      started = $started
    }
    exit 0
  }

  # ---- 3) 截图 + OCR 定位目标行 ----
  # 浮窗面板是失焦就关的 popup，不能慢吞吞：置顶后立刻重取一次句柄和尺寸再截，
  # 截不到就重新点一次手机图标（最多 3 轮）。
  $pr = New-Object WxTk+RECT
  $captured = $false
  for ($try = 1; $try -le 3; $try++) {
    [WxTk]::TopMost($panel, $true) | Out-Null
    Start-Sleep -Milliseconds 500
    $panel = [WxTk]::Panel()
    if ($panel -eq [IntPtr]::Zero) {
      [WxTk]::GetWindowRect($wx, [ref]$r) | Out-Null
      Click ([int]($r.Left + ($r.Right - $r.Left) * 0.0197)) ([int]($r.Top + ($r.Bottom - $r.Top) * 0.929))
      Start-Sleep -Milliseconds 1500
      $panel = [WxTk]::Panel()
      if ($panel -eq [IntPtr]::Zero) { continue }
    }
    [WxTk]::GetWindowRect($panel, [ref]$pr) | Out-Null
    if (($pr.Right - $pr.Left) -le 50 -or ($pr.Bottom - $pr.Top) -le 50) { continue }
    if ([WxTk]::Capture($panel, $shot)) { $captured = $true; break }
  }
  if (-not $captured) {
    Out-Json @{ ok = $false; error = "浮窗面板截图失败（面板可能一失焦就关了）"; shot = $shot }
    exit 0
  }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($shot)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sbitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) { Out-Json @{ ok = $false; error = "系统 OCR 不可用（缺中文语言包？）"; shot = $shot }; exit 0 }
  $ocr = Await ($engine.RecognizeAsync($sbitmap)) ([Windows.Media.Ocr.OcrResult])

  $hit = $null
  $hitText = ""
  foreach ($line in $ocr.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $clean = ($line.Text -replace "\s", "")
    if ($clean.Contains($Keyword)) {
      $x1 = [double]$words[0].BoundingRect.X
      $y1 = [double]$words[0].BoundingRect.Y
      $lw = $words[$words.Count - 1]
      $x2 = [double]$lw.BoundingRect.X + [double]$lw.BoundingRect.Width
      $y2 = [double]$lw.BoundingRect.Y + [double]$lw.BoundingRect.Height
      $hit = @{ x = [int](($x1 + $x2) / 2); y = [int](($y1 + $y2) / 2) }
      $hitText = $clean
      break
    }
  }
  if ($hit -eq $null) {
    [WxTk]::TopMost($panel, $false) | Out-Null
    $seen = (($ocr.Lines | ForEach-Object { ($_.Text -replace "\s", "") }) -join " | ")
    Out-Json @{
      ok = $false
      error = ("浮窗里没找到含「" + $Keyword + "」的条目。" +
        "请先在手机微信里从「南医大教学」→底部菜单「本科」进入教务系统，点右上角「···」→「浮窗」；" +
        "之后电脑版微信的浮窗面板里就会出现「教学服务平台系统」。当前面板识别到：" + $seen)
      shot = $shot
    }
    exit 0
  }

  # ---- 4) 点它，等页面加载（OAuth 在这里完成）----
  $cx = [int]($pr.Left + $hit.x)
  $cy = [int]($pr.Top + $hit.y)
  Click $cx $cy
  Start-Sleep -Milliseconds $WaitMs

  # ---- 5) 收尾：关掉内置浏览器窗口 ----
  $closed = 0
  if (-not $KeepWindow) {
    $browser = [WxTk]::Browser()
    if ($browser -ne [IntPtr]::Zero) {
      $br = New-Object WxTk+RECT
      [WxTk]::GetWindowRect($browser, [ref]$br) | Out-Null
      if ((($br.Right - $br.Left) * ($br.Bottom - $br.Top)) -gt 40000) {
        [WxTk]::CloseWindow($browser) | Out-Null
        $closed += 1
        Start-Sleep -Milliseconds 1200
      }
    }
  }

  Out-Json @{
    ok = $true
    matched = $hitText
    clickedX = $cx
    clickedY = $cy
    closed = $closed
    started = $started
    shot = $shot
  }
} catch {
  Out-Json @{ ok = $false; error = ("脚本异常：" + $_.Exception.Message); shot = $shot }
}

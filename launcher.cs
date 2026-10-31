using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Windows.Forms;

/**
 * 南医大评课助手 · 启动器（带托盘图标）
 *
 * 双击：后台启动本地服务 + 打开浏览器界面，程序缩到托盘常驻。
 * 托盘右键：打开界面 / 查看日志 / 退出程序（会先停服务再退出）。
 * 服务被界面里的「退出程序」或外部关掉后，托盘图标自动消失。
 */
internal static class Launcher
{
    private const string Url = "http://127.0.0.1:17320/";
    private const string StateUrl = "http://127.0.0.1:17320/api/state";
    private const string QuitUrl = "http://127.0.0.1:17320/api/quit";

    private static NotifyIcon tray;
    private static Process server;
    private static volatile bool shuttingDown;

    [STAThread]
    private static int Main(string[] args)
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string nodeExe = Path.Combine(appDir, "node", "node.exe");
        string serverJs = Path.Combine(appDir, "server.mjs");
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "smueval-bot");
        string serverLog = Path.Combine(dataDir, "server.log");

        if (!File.Exists(nodeExe) || !File.Exists(serverJs))
        {
            ShowError("程序文件不完整。\r\n\r\n缺少：" + (File.Exists(nodeExe) ? serverJs : nodeExe) +
                      "\r\n\r\n请确认解压时选择了「全部文件」。");
            return 1;
        }

        if (!IsServerUp())
        {
            Directory.CreateDirectory(dataDir);
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };
            try
            {
                server = Process.Start(psi);
            }
            catch (Exception ex)
            {
                ShowError("启动本地服务失败：\r\n" + ex.Message);
                return 1;
            }
            if (server == null)
            {
                ShowError("启动本地服务失败（进程没创建成功）。");
                return 1;
            }

            var logLock = new object();
            Action<string> append = (line) =>
            {
                try { lock (logLock) File.AppendAllText(serverLog, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n"); }
                catch { }
            };
            server.OutputDataReceived += (s, e) => { if (e.Data != null) append(e.Data); };
            server.ErrorDataReceived += (s, e) => { if (e.Data != null) append("[err] " + e.Data); };
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            bool ready = false;
            for (int i = 0; i < 40; i++)
            {
                if (server.HasExited)
                {
                    ShowError("服务启动后立刻退出了（退出码 " + server.ExitCode + "）。\r\n\r\n日志：" + serverLog);
                    return 1;
                }
                if (IsServerUp()) { ready = true; break; }
                Thread.Sleep(500);
            }
            if (!ready)
            {
                ShowError("等了 20 秒服务还没起来。\r\n\r\n可能原因：\r\n· 端口 17320 被别的程序占用\r\n· 安全软件拦截了运行（可试着右键 → 以管理员身份运行）\r\n\r\n日志：" + serverLog);
                return 1;
            }
        }

        tray = new NotifyIcon
        {
            Icon = LoadIcon(appDir),
            Text = "南医大评课助手（双击打开界面）",
            Visible = true,
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开操作界面", null, (s, e) => OpenBrowser());
        menu.Items.Add("查看运行日志", null, (s, e) => OpenPath(serverLog));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出程序（停止服务）", null, (s, e) => Quit());
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (s, e) => OpenBrowser();
        tray.BalloonTipTitle = "南医大评课助手";
        tray.BalloonTipText = "已在后台运行。双击托盘图标打开界面，右键可退出。";
        try { tray.ShowBalloonTip(4000); } catch { }

        OpenBrowser();

        var watcher = new System.Windows.Forms.Timer { Interval = 3000 };
        watcher.Tick += (s, e) =>
        {
            if (shuttingDown) return;
            bool alive = server != null ? (!server.HasExited && IsServerUp()) : IsServerUp();
            if (!alive)
            {
                try { tray.Visible = false; tray.Dispose(); } catch { }
                Application.Exit();
            }
        };
        watcher.Start();

        Application.Run();
        return 0;
    }

    private static Icon LoadIcon(string appDir)
    {
        try
        {
            string icoPath = Path.Combine(appDir, "app.ico");
            if (File.Exists(icoPath)) return new Icon(icoPath);
        }
        catch { }
        return SystemIcons.Application;
    }

    private static bool IsServerUp()
    {
        try
        {
            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromSeconds(2);
                var text = client.GetStringAsync(StateUrl).GetAwaiter().GetResult();
                return text != null && text.Contains("\"ok\":true");
            }
        }
        catch { return false; }
    }

    private static void OpenBrowser()
    {
        try { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
        catch (Exception ex) { ShowError("没能打开浏览器，请手动访问：" + Url + "\r\n\r\n" + ex.Message); }
    }

    private static void OpenPath(string path)
    {
        try
        {
            if (File.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            else ShowError("还没有日志文件：\r\n" + path);
        }
        catch (Exception ex) { ShowError("打不开：\r\n" + ex.Message); }
    }

    private static void Quit()
    {
        shuttingDown = true;
        try
        {
            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromSeconds(5);
                var res = client.PostAsync(QuitUrl, new StringContent("{}")).GetAwaiter().GetResult();
                string body = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                if (!res.IsSuccessStatusCode)
                {
                    MessageBox.Show(
                        "现在还不能退出：\r\n\r\n" + body,
                        "南医大评课助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    shuttingDown = false;
                    return;
                }
            }
        }
        catch { }

        try
        {
            if (server != null && !server.HasExited)
            {
                server.WaitForExit(3000);
                if (!server.HasExited) server.Kill();
            }
        }
        catch { }

        try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch { }
        Application.Exit();
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "南医大评课助手", MessageBoxButtons.OK, MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
    }
}

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

/**
 * 南医大评课助手 · 单文件自解压启动器
 *
 * 把整个运行目录（node 运行时 + 源码 + playwright-core + 模型）压成一个 zip
 * 嵌在本 exe 里。双击时：
 *   1. 解压到 %LOCALAPPDATA%\smueval-bot\app（已解压过且版本一致就跳过）
 *   2. 启动里面的「南医大评课助手.exe」（托盘启动器）
 *   3. 本程序退出
 *
 * 用户只需一个 exe，无需解压、无需装 Node.js。
 */
internal static class Sfx
{
    private const string ResourceName = "payload.zip";
    private const string VersionStamp = "2026-11-02-v2";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string baseDir = Path.Combine(appData, "smueval-bot");
            string extractDir = Path.Combine(baseDir, "app");
            string stampFile = Path.Combine(extractDir, ".payload-version");
            string launcher = Path.Combine(extractDir, "南医大评课助手.exe");

            bool needExtract = true;
            if (File.Exists(stampFile) && File.Exists(launcher))
            {
                try
                {
                    needExtract = File.ReadAllText(stampFile).Trim() != VersionStamp;
                }
                catch { needExtract = true; }
            }

            if (needExtract)
            {
                Directory.CreateDirectory(baseDir);
                if (Directory.Exists(extractDir))
                {
                    try { Directory.Delete(extractDir, true); }
                    catch { }
                }
                Directory.CreateDirectory(extractDir);

                string tempZip = Path.Combine(Path.GetTempPath(), "smueval_payload_" + Guid.NewGuid().ToString("N") + ".zip");
                try
                {
                    using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
                    {
                        if (res == null)
                        {
                            ShowError("程序内部数据缺失，无法解压。请重新下载完整的 exe 文件。");
                            return 1;
                        }
                        using (FileStream fs = File.Create(tempZip))
                        {
                            res.CopyTo(fs, 81920);
                        }
                    }

                    ZipFile.ExtractToDirectory(tempZip, extractDir);
                    File.WriteAllText(stampFile, VersionStamp);
                }
                finally
                {
                    try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { }
                }
            }

            if (!File.Exists(launcher))
            {
                ShowError("解压后找不到主程序：\r\n" + launcher + "\r\n\r\n请检查安全软件是否拦截了文件释放，或删除目录后重试：\r\n" + extractDir);
                return 1;
            }

            var psi = new ProcessStartInfo
            {
                FileName = launcher,
                WorkingDirectory = extractDir,
                UseShellExecute = true,
            };
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            ShowError("启动失败：\r\n" + ex.Message);
            return 1;
        }
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "南医大评课助手", MessageBoxButtons.OK, MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
    }
}

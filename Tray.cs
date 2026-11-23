using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Notification-area icon for the windowless WebTerm process: the only visible handle on it.
// WinForms needs an STA thread with its own message loop, separate from Kestrel's threads.
static class Tray
{
    static NotifyIcon? _icon;

    public static void Start(string url, string logPath, Func<int> sessionCount, Action restart, Action exit)
    {
        var thread = new Thread(() => Run(url, logPath, sessionCount, restart, exit))
        {
            IsBackground = true,
            Name = "Tray"
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        // Without this the icon lingers in the tray after exit until the mouse passes over it.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Remove();
    }

    public static void Remove()
    {
        try { if (_icon != null) _icon.Visible = false; } catch { }
    }

    static void Run(string url, string logPath, Func<int> sessionCount, Action restart, Action exit)
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open WebTerm", null, (_, _) => Open(url)) { Font = new Font(menu.Font, FontStyle.Bold) };
        var status = new ToolStripMenuItem { Enabled = false };
        menu.Items.Add(open);
        menu.Items.Add(status);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open log", null, (_, _) => Open(logPath));
        menu.Items.Add("Restart (rebuild)", null, (_, _) =>
        {
            if (Confirm(sessionCount(), "Restart")) restart();
        });
        menu.Items.Add("Exit", null, (_, _) =>
        {
            if (Confirm(sessionCount(), "Exit")) exit();
        });
        menu.Opening += (_, _) =>
        {
            var n = sessionCount();
            status.Text = n == 1 ? "1 session" : $"{n} sessions";
        };

        _icon = new NotifyIcon
        {
            Icon = DrawIcon(),
            Text = $"WebTerm — {url}",
            ContextMenuStrip = menu,
            Visible = true
        };
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) Open(url); };

        Application.Run();
    }

    // Exiting or restarting kills every PTY, so ask first when any session is live.
    static bool Confirm(int sessions, string action)
    {
        if (sessions == 0) return true;
        var what = sessions == 1 ? "1 open session" : $"{sessions} open sessions";
        return MessageBox.Show(
            $"{action} WebTerm? This ends {what} (shells and Claude processes).",
            "WebTerm", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2) == DialogResult.OK;
    }

    static void Open(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
    }

    // A ">_" prompt on a dark rounded square, drawn at runtime so no .ico asset is needed.
    static Icon DrawIcon()
    {
        const int size = 32;
        using var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using var path = new GraphicsPath();
            const int r = 7;
            path.AddArc(0, 0, r * 2, r * 2, 180, 90);
            path.AddArc(size - 1 - r * 2, 0, r * 2, r * 2, 270, 90);
            path.AddArc(size - 1 - r * 2, size - 1 - r * 2, r * 2, r * 2, 0, 90);
            path.AddArc(0, size - 1 - r * 2, r * 2, r * 2, 90, 90);
            path.CloseFigure();
            using var bg = new SolidBrush(Color.FromArgb(30, 30, 30));
            g.FillPath(bg, path);
            using var border = new Pen(Color.FromArgb(46, 160, 67), 2);
            g.DrawPath(border, path);
            using var font = new Font("Consolas", 13, FontStyle.Bold, GraphicsUnit.Pixel);
            using var fg = new SolidBrush(Color.FromArgb(46, 200, 80));
            g.DrawString(">_", font, fg, 4, 8);
        }
        // GetHicon's handle isn't owned by the Icon; clone so the icon owns its own copy.
        var handle = bmp.GetHicon();
        using var temp = Icon.FromHandle(handle);
        var icon = (Icon)temp.Clone();
        DestroyIcon(handle);
        return icon;
    }

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr handle);
}

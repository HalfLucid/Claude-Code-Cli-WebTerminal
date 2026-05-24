using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Porta.Pty;

var settingsPath = Path.Combine(AppContext.BaseDirectory, "webterm-settings.json");
var sm = new SettingsManager(settingsPath);
var settings = sm.Load();

if (settings.Credentials is null)
{
    Console.WriteLine("=== WebTerm First-Run Setup ===");
    Console.WriteLine("No credentials found. Please set up your login.");
    Console.Write("Username: ");
    var username = Console.ReadLine()?.Trim();
    if (string.IsNullOrEmpty(username)) { Console.WriteLine("Username cannot be empty."); return; }
    Console.Write("Password: ");
    var password = ReadPassword();
    if (string.IsNullOrEmpty(password)) { Console.WriteLine("Password cannot be empty."); return; }
    Console.Write("Confirm password: ");
    var confirm = ReadPassword();
    if (password != confirm) { Console.WriteLine("Passwords do not match."); return; }
    settings.Credentials = new CredentialSettings
    {
        UsernameProtected = SettingsManager.Protect(username),
        PasswordProtected = SettingsManager.Protect(password)
    };
    sm.Save(settings);
    Console.WriteLine("Credentials saved (encrypted with DPAPI).");
}

var (authUser, authPass) = sm.DecryptCredentials(settings.Credentials);
var expected = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{authUser}:{authPass}"));

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.Use(async (ctx, next) =>
{
    if (ctx.Request.Headers.Authorization != expected)
    {
        ctx.Response.Headers["WWW-Authenticate"] = "Basic realm=\"webterm\"";
        ctx.Response.StatusCode = 401;
        return;
    }
    await next();
});

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

app.UseDefaultFiles();
app.UseStaticFiles();

var sessions = new ConcurrentDictionary<string, Session>();

_ = Task.Run(async () =>
{
    while (true)
    {
        await Task.Delay(TimeSpan.FromMinutes(1));
        var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(30);
        foreach (var kv in sessions)
        {
            if (kv.Value.IsIdleSince(cutoff) && sessions.TryRemove(kv.Key, out var s))
                s.Dispose();
        }
    }
});

app.MapGet("/api/settings", () =>
{
    var current = sm.Load();
    return Results.Json(new
    {
        projects = current.Projects,
        buttons = current.Buttons,
        defaultPowershellColor = current.DefaultPowershellColor
    });
});

app.MapPost("/api/projects", async (HttpContext ctx) =>
{
    var proj = await ctx.Request.ReadFromJsonAsync<ProjectSettings>();
    if (proj is null || string.IsNullOrWhiteSpace(proj.Name)) return Results.BadRequest();
    proj.Id = Guid.NewGuid().ToString();
    var current = sm.Load();
    current.Projects.Add(proj);
    sm.Save(current);
    return Results.Json(proj, statusCode: 201);
});

app.MapPut("/api/projects/{id}", async (string id, HttpContext ctx) =>
{
    var update = await ctx.Request.ReadFromJsonAsync<ProjectSettings>();
    if (update is null) return Results.BadRequest();
    var current = sm.Load();
    var existing = current.Projects.FirstOrDefault(p => p.Id == id);
    if (existing is null) return Results.NotFound();
    existing.Name = update.Name;
    existing.Directory = update.Directory;
    existing.Color = update.Color;
    sm.Save(current);
    return Results.Json(existing);
});

app.MapDelete("/api/projects/{id}", (string id) =>
{
    var current = sm.Load();
    var removed = current.Projects.RemoveAll(p => p.Id == id);
    if (removed == 0) return Results.NotFound();
    sm.Save(current);
    return Results.Ok();
});

app.MapPut("/api/buttons", async (HttpContext ctx) =>
{
    var btn = await ctx.Request.ReadFromJsonAsync<ButtonConfig>();
    if (btn is null) return Results.BadRequest();
    var current = sm.Load();
    current.Buttons = btn;
    sm.Save(current);
    return Results.Ok();
});

app.MapGet("/api/startup", () =>
{
    var startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
    var shortcutPath = Path.Combine(startupDir, "webterm.lnk");
    return Results.Json(new { enabled = File.Exists(shortcutPath) });
});

app.MapPost("/api/startup", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<JsonElement>();
    var enable = body.GetProperty("enabled").GetBoolean();
    var startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
    var shortcutPath = Path.Combine(startupDir, "webterm.lnk");

    if (enable)
    {
        var exePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
        if (exePath is null) return Results.Problem("Cannot determine executable path");
        var workDir = Path.GetDirectoryName(exePath)!;
        // Use PowerShell to create .lnk shortcut (no COM interop needed)
        var ps = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"""
                -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{shortcutPath.Replace("'", "''")}');$s.TargetPath='{exePath.Replace("'", "''")}';$s.WorkingDirectory='{workDir.Replace("'", "''")}';$s.Save()"
                """,
            CreateNoWindow = true,
            UseShellExecute = false
        };
        Process.Start(ps)?.WaitForExit(5000);
    }
    else
    {
        if (File.Exists(shortcutPath)) File.Delete(shortcutPath);
    }
    return Results.Json(new { enabled = File.Exists(shortcutPath) });
});

app.Map("/ws", async ctx =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    var sid = ctx.Request.Query["sid"].ToString();
    if (string.IsNullOrWhiteSpace(sid) || !Guid.TryParse(sid, out _))
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    var session = sessions.GetOrAdd(sid, _ => Session.Create());
    await session.Attach(ws, sm);
});

var listenUrl = "http://0.0.0.0:7681";
app.Lifetime.ApplicationStarted.Register(() =>
{
    try
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "http://localhost:7681",
            UseShellExecute = true
        });
    }
    catch { }
});

app.Run(listenUrl);

static string ReadPassword()
{
    var sb = new StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter) { Console.WriteLine(); break; }
        if (key.Key == ConsoleKey.Backspace && sb.Length > 0)
        {
            sb.Remove(sb.Length - 1, 1);
            Console.Write("\b \b");
        }
        else if (!char.IsControl(key.KeyChar))
        {
            sb.Append(key.KeyChar);
            Console.Write('*');
        }
    }
    return sb.ToString();
}

sealed class Session : IDisposable
{
    const int MaxBuffer = 256 * 1024;

    public IPtyConnection? Pty { get; private set; }
    readonly object _lock = new();
    readonly LinkedList<(long start, byte[] data)> _chunks = new();
    long _totalBytes;
    WebSocket? _current;
    Channel<byte[]>? _channel;
    DateTime _lastDetached = DateTime.UtcNow;
    bool _disposed;
    int _cols = 120, _rows = 30;
    bool _launched;

    public static Session Create() => new Session();

    public bool IsLaunched { get { lock (_lock) return _launched; } }

    public void Launch(string kind, string? projectId, SettingsManager sm)
    {
        lock (_lock)
        {
            if (_launched) return;
            _launched = true;
        }
        var ps = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        string cwd;
        string[] cmd;

        if (kind == "powershell")
        {
            cwd = home;
            cmd = ["-NoExit"];
        }
        else
        {
            var current = sm.Load();
            var project = current.Projects.FirstOrDefault(p => p.Id == projectId);
            cwd = project?.Directory ?? home;
            var claudeCmd = kind == "claude-resume" ? "claude --resume" : "claude";
            cmd = ["-NoExit", "-Command", claudeCmd];
        }

        var opts = new PtyOptions
        {
            Name = "xterm-256color",
            Cols = _cols,
            Rows = _rows,
            Cwd = cwd,
            App = ps,
            CommandLine = cmd,
            Environment = new Dictionary<string, string>()
        };
        Pty = PtyProvider.SpawnAsync(opts, CancellationToken.None).GetAwaiter().GetResult();
        _ = Task.Run(ReadLoop);
    }

    async Task ReadLoop()
    {
        var buf = new byte[4096];
        try
        {
            while (true)
            {
                var n = await Pty!.ReaderStream.ReadAsync(buf);
                if (n == 0) break;
                var copy = new byte[n];
                Buffer.BlockCopy(buf, 0, copy, 0, n);

                Channel<byte[]>? ch;
                lock (_lock)
                {
                    _chunks.AddLast((_totalBytes, copy));
                    _totalBytes += n;
                    while (_chunks.Count > 1)
                    {
                        var first = _chunks.First!.Value;
                        var afterEvict = _totalBytes - (first.start + first.data.Length);
                        if (afterEvict >= MaxBuffer) _chunks.RemoveFirst();
                        else break;
                    }
                    ch = _channel;
                }
                ch?.Writer.TryWrite(copy);
            }
        }
        catch { }
    }

    public async Task Attach(WebSocket ws, SettingsManager sm)
    {
        WebSocket? old;
        Channel<byte[]>? oldCh;
        byte[][] snapshot;
        Channel<byte[]> ch;
        lock (_lock)
        {
            old = _current;
            oldCh = _channel;
            _current = ws;
            ch = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
            _channel = ch;
            snapshot = _chunks.Select(c => c.data).ToArray();
        }
        oldCh?.Writer.TryComplete();
        if (old != null)
        {
            try { await old.CloseAsync(WebSocketCloseStatus.NormalClosure, "replaced", default); } catch { }
        }

        try
        {
            foreach (var c in snapshot)
                await ws.SendAsync(c, WebSocketMessageType.Binary, true, default);
            if (!IsLaunched)
            {
                var msg = Encoding.UTF8.GetBytes("{\"choose\":true}");
                await ws.SendAsync(msg, WebSocketMessageType.Text, true, default);
            }
        }
        catch { }

        var sendPump = Task.Run(async () =>
        {
            try
            {
                await foreach (var data in ch.Reader.ReadAllAsync())
                {
                    if (ws.CloseStatus.HasValue) break;
                    await ws.SendAsync(data, WebSocketMessageType.Binary, true, default);
                }
            }
            catch { }
        });

        var buf2 = new byte[4096];
        try
        {
            while (!ws.CloseStatus.HasValue)
            {
                var r = await ws.ReceiveAsync(buf2, default);
                if (r.MessageType == WebSocketMessageType.Close) break;
                if (r.MessageType == WebSocketMessageType.Text)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(buf2.AsMemory(0, r.Count));
                        var root = doc.RootElement;
                        if (root.TryGetProperty("launch", out var lk) && lk.ValueKind == JsonValueKind.String)
                        {
                            string? projId = null;
                            if (root.TryGetProperty("projectId", out var pid) && pid.ValueKind == JsonValueKind.String)
                                projId = pid.GetString();
                            Launch(lk.GetString()!, projId, sm);
                        }
                        else if (root.TryGetProperty("cols", out var c) && root.TryGetProperty("rows", out var rr))
                        {
                            var ci = c.GetInt32(); var ri = rr.GetInt32();
                            lock (_lock) { _cols = ci; _rows = ri; }
                            Pty?.Resize(ci, ri);
                        }
                    }
                    catch { }
                    continue;
                }
                if (Pty == null) continue;
                await Pty.WriterStream.WriteAsync(buf2.AsMemory(0, r.Count));
                await Pty.WriterStream.FlushAsync();
            }
        }
        catch { }
        finally
        {
            lock (_lock)
            {
                if (_current == ws)
                {
                    _current = null;
                    _channel?.Writer.TryComplete();
                    _channel = null;
                    _lastDetached = DateTime.UtcNow;
                }
            }
            try { await sendPump; } catch { }
        }
    }

    public bool IsIdleSince(DateTime cutoff)
    {
        lock (_lock)
        {
            return _current == null && _lastDetached < cutoff;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { Pty?.Kill(); } catch { }
        try { Pty?.Dispose(); } catch { }
    }
}

class WebtermSettings
{
    [JsonPropertyName("credentials")]
    public CredentialSettings? Credentials { get; set; }

    [JsonPropertyName("projects")]
    public List<ProjectSettings> Projects { get; set; } = [];

    [JsonPropertyName("buttons")]
    public ButtonConfig Buttons { get; set; } = new();

    [JsonPropertyName("defaultPowershellColor")]
    public string DefaultPowershellColor { get; set; } = "#1e6f1e";
}

class CredentialSettings
{
    [JsonPropertyName("usernameProtected")]
    public string UsernameProtected { get; set; } = "";

    [JsonPropertyName("passwordProtected")]
    public string PasswordProtected { get; set; } = "";
}

class ProjectSettings
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("directory")]
    public string Directory { get; set; } = "";

    [JsonPropertyName("color")]
    public string Color { get; set; } = "#4a90d9";
}

class ButtonConfig
{
    [JsonPropertyName("order")]
    public List<string> Order { get; set; } = ["enter", "up", "down", "left", "right", "ctrl-c", "esc", "tab", "shift-tab", "ctrl-b", "ctrl-o", "clr", "cmpt", "model", "effort"];

    [JsonPropertyName("custom")]
    public List<CustomButton> Custom { get; set; } = [];
}

class CustomButton
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("command")]
    public string Command { get; set; } = "";
}

class SettingsManager
{
    readonly string _path;
    readonly object _writeLock = new();
    static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public SettingsManager(string path) => _path = path;

    public WebtermSettings Load()
    {
        if (!File.Exists(_path)) return new WebtermSettings();
        var json = File.ReadAllText(_path);
        return JsonSerializer.Deserialize<WebtermSettings>(json, _jsonOpts) ?? new WebtermSettings();
    }

    public void Save(WebtermSettings s)
    {
        lock (_writeLock)
        {
            File.WriteAllText(_path, JsonSerializer.Serialize(s, _jsonOpts));
        }
    }

    public static string Protect(string plaintext)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(encrypted);
    }

    public static string Unprotect(string protectedBase64)
    {
        var encrypted = Convert.FromBase64String(protectedBase64);
        var bytes = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes);
    }

    public (string user, string pass) DecryptCredentials(CredentialSettings creds)
    {
        return (Unprotect(creds.UsernameProtected), Unprotect(creds.PasswordProtected));
    }
}

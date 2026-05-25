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

string GetClientIp(HttpContext ctx)
{
    var forwarded = ctx.Request.Headers["X-Forwarded-For"].FirstOrDefault();
    if (!string.IsNullOrEmpty(forwarded)) return forwarded.Split(',')[0].Trim();
    return ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}

void Log(string message) => Console.WriteLine($"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}");

app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path == "/mcp")
    {
        await next();
        return;
    }
    if (ctx.Request.Headers.Authorization != expected)
    {
        var ip = GetClientIp(ctx);
        Log($"AUTH DENIED from {ip} — {ctx.Request.Method} {ctx.Request.Path}");
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
var sseClients = new ConcurrentDictionary<string, Channel<string>>();

void BroadcastSse(string eventType, object data)
{
    var json = JsonSerializer.Serialize(data);
    var message = $"event: {eventType}\ndata: {json}\n\n";
    foreach (var kv in sseClients)
    {
        if (!kv.Value.Writer.TryWrite(message))
        {
            sseClients.TryRemove(kv.Key, out _);
            kv.Value.Writer.TryComplete();
        }
    }
}

_ = Task.Run(async () =>
{
    while (true)
    {
        await Task.Delay(TimeSpan.FromMinutes(1));
        var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(30);
        foreach (var kv in sessions)
        {
            if (kv.Value.IsIdleSince(cutoff) && sessions.TryRemove(kv.Key, out var s))
            {
                Log($"SESSION REAPED sid={kv.Key[..8]}… (idle 30m, {s.Stats})");
                s.Dispose();
                BroadcastSse("tab_closed", new { sid = kv.Key });
            }
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

app.MapGet("/api/sessions", () =>
{
    var list = sessions.Select(kv => new
    {
        sid = kv.Key,
        kind = kv.Value.Kind ?? "unknown",
        label = kv.Value.Label ?? "unknown",
        color = kv.Value.Color ?? "#1e6f1e",
        projectId = kv.Value.ProjectId,
        launched = kv.Value.IsLaunched,
        connected = kv.Value.HasWebSocket
    }).ToArray();
    return Results.Json(list);
});

app.MapDelete("/api/sessions/{sid}", (string sid) =>
{
    if (!sessions.TryRemove(sid, out var session))
        return Results.NotFound(new { error = "Session not found" });

    Log($"SESSION CLOSED sid={sid[..Math.Min(8, sid.Length)]}… (client request, {session.Stats})");
    session.Dispose();
    BroadcastSse("tab_closed", new { sid });
    return Results.Ok(new { closed = sid });
});

app.MapGet("/api/events", async (HttpContext ctx) =>
{
    ctx.Response.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";

    var clientId = Guid.NewGuid().ToString();
    var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(64)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true
    });
    sseClients[clientId] = channel;

    try
    {
        await ctx.Response.WriteAsync(": connected\n\n");
        await ctx.Response.Body.FlushAsync();

        await foreach (var message in channel.Reader.ReadAllAsync(ctx.RequestAborted))
        {
            await ctx.Response.WriteAsync(message);
            await ctx.Response.Body.FlushAsync();
        }
    }
    catch (OperationCanceledException) { }
    finally
    {
        sseClients.TryRemove(clientId, out _);
        channel.Writer.TryComplete();
    }
});

app.MapPost("/api/mcp-setup", () =>
{
    var current = sm.Load();
    string mcpKey;
    if (!string.IsNullOrEmpty(current.McpKeyProtected))
    {
        mcpKey = SettingsManager.Unprotect(current.McpKeyProtected);
    }
    else
    {
        var keyBytes = RandomNumberGenerator.GetBytes(32);
        mcpKey = Convert.ToBase64String(keyBytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
        current.McpKeyProtected = SettingsManager.Protect(mcpKey);
        sm.Save(current);
        Log("MCP key generated and saved");
    }
    var url = $"http://localhost:7681/mcp?token={Uri.EscapeDataString(mcpKey)}";
    var command = $"claude mcp add webterm --transport http \"{url}\" -s user";
    return Results.Json(new { command, url });
});

app.MapPost("/mcp", async (HttpContext ctx) =>
{
    var token = ctx.Request.Query["token"].ToString();
    var current = sm.Load();
    if (string.IsNullOrEmpty(current.McpKeyProtected) || string.IsNullOrEmpty(token))
    {
        ctx.Response.StatusCode = 401;
        await ctx.Response.WriteAsJsonAsync(new { error = "Missing MCP token" });
        return;
    }
    try
    {
        var expectedKey = SettingsManager.Unprotect(current.McpKeyProtected);
        if (token != expectedKey)
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new { error = "Invalid MCP token" });
            return;
        }
    }
    catch
    {
        ctx.Response.StatusCode = 401;
        await ctx.Response.WriteAsJsonAsync(new { error = "Token validation failed" });
        return;
    }

    JsonElement req;
    try { req = await ctx.Request.ReadFromJsonAsync<JsonElement>(); }
    catch
    {
        await ctx.Response.WriteAsJsonAsync(McpError(null, -32700, "Parse error"));
        return;
    }

    var id = req.TryGetProperty("id", out var idProp) ? idProp : (JsonElement?)null;
    var method = req.TryGetProperty("method", out var m) ? m.GetString() : null;

    object response = method switch
    {
        "initialize" => McpResult(id, new
        {
            protocolVersion = "2024-11-05",
            serverInfo = new { name = "webterm", version = "1.0.0" },
            capabilities = new { tools = new { } }
        }),
        "notifications/initialized" => McpResult(id, new { }),
        "tools/list" => McpResult(id, new
        {
            tools = new object[]
            {
                McpToolDef("open_tab",
                    "Open a new terminal tab in WebTerm. Creates a PTY session and notifies the browser.",
                    new
                    {
                        type = "object",
                        properties = new Dictionary<string, object>
                        {
                            ["kind"] = new { type = "string", description = "Session type", @enum = new[] { "powershell", "claude", "claude-resume" } },
                            ["projectId"] = new { type = "string", description = "Project ID (required for claude/claude-resume)" },
                            ["label"] = new { type = "string", description = "Tab label shown in browser" },
                            ["command"] = new { type = "string", description = "Command to execute after launch" }
                        },
                        required = new[] { "kind" }
                    }),
                McpToolDef("close_tab",
                    "Close a terminal tab by session ID.",
                    new
                    {
                        type = "object",
                        properties = new Dictionary<string, object>
                        {
                            ["sid"] = new { type = "string", description = "Session ID to close" }
                        },
                        required = new[] { "sid" }
                    }),
                McpToolDef("list_tabs",
                    "List all active terminal sessions.",
                    new { type = "object", properties = new Dictionary<string, object>() })
            }
        }),
        "tools/call" => McpHandleToolCall(req, id),
        _ => McpError(id, -32601, $"Method not found: {method}")
    };

    await ctx.Response.WriteAsJsonAsync(response);
});

object McpResult(JsonElement? id, object result) => new
{
    jsonrpc = "2.0",
    id = id?.ValueKind == JsonValueKind.Number ? (object)id.Value.GetInt32()
        : id?.ValueKind == JsonValueKind.String ? id.Value.GetString() : null,
    result
};

object McpError(JsonElement? id, int code, string message) => new
{
    jsonrpc = "2.0",
    id = id?.ValueKind == JsonValueKind.Number ? (object)id.Value.GetInt32()
        : id?.ValueKind == JsonValueKind.String ? id.Value.GetString() : null,
    error = new { code, message }
};

object McpToolDef(string name, string description, object inputSchema) => new { name, description, inputSchema };

object McpHandleToolCall(JsonElement req, JsonElement? id)
{
    var toolName = req.GetProperty("params").GetProperty("name").GetString();
    var args = req.GetProperty("params").TryGetProperty("arguments", out var a) ? a : default;

    return toolName switch
    {
        "open_tab" => McpOpenTab(id, args),
        "close_tab" => McpCloseTab(id, args),
        "list_tabs" => McpListTabs(id),
        _ => McpError(id, -32602, $"Unknown tool: {toolName}")
    };
}

object McpOpenTab(JsonElement? id, JsonElement args)
{
    var kind = args.TryGetProperty("kind", out var k) ? k.GetString() ?? "powershell" : "powershell";
    var projectId = args.TryGetProperty("projectId", out var p) ? p.GetString() : null;
    var label = args.TryGetProperty("label", out var l) ? l.GetString() : kind;
    var command = args.TryGetProperty("command", out var c) ? c.GetString() : null;

    string color = "#1e6f1e";
    if (kind != "powershell" && projectId != null)
    {
        var proj = sm.Load().Projects.FirstOrDefault(pr => pr.Id == projectId);
        if (proj != null) color = proj.Color;
    }

    var sid = Guid.NewGuid().ToString();
    var session = Session.Create(kind, label, color, projectId);
    sessions[sid] = session;

    var sidShort = sid[..8];
    session.Launch(kind, projectId, sm, sidShort, Log, command);

    BroadcastSse("tab_opened", new { sid, kind, label, color, projectId });
    Log($"MCP OPEN sid={sidShort}… kind={kind} label={label}");

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = $"Tab opened: sid={sid}, kind={kind}, label={label}" } }
    });
}

object McpCloseTab(JsonElement? id, JsonElement args)
{
    var sid = args.TryGetProperty("sid", out var s) ? s.GetString() : null;
    if (string.IsNullOrEmpty(sid))
        return McpError(id, -32602, "Missing required parameter: sid");

    if (!sessions.TryRemove(sid, out var session))
        return McpResult(id, new
        {
            content = new[] { new { type = "text", text = $"No session found with sid={sid}" } },
            isError = true
        });

    session.Dispose();
    BroadcastSse("tab_closed", new { sid });
    Log($"MCP CLOSE sid={sid[..8]}…");

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = $"Tab closed: sid={sid}" } }
    });
}

object McpListTabs(JsonElement? id)
{
    var tabList = sessions.Select(kv => new
    {
        sid = kv.Key,
        kind = kv.Value.Kind ?? "unknown",
        label = kv.Value.Label ?? "unknown",
        color = kv.Value.Color ?? "#1e6f1e",
        projectId = kv.Value.ProjectId,
        launched = kv.Value.IsLaunched,
        connected = kv.Value.HasWebSocket
    }).ToArray();

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = JsonSerializer.Serialize(tabList) } }
    });
}

app.Map("/ws", async ctx =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    var sid = ctx.Request.Query["sid"].ToString();
    if (string.IsNullOrWhiteSpace(sid) || !Guid.TryParse(sid, out _))
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    var ip = GetClientIp(ctx);
    var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    var isNew = false;
    var session = sessions.GetOrAdd(sid, _ => { isNew = true; return Session.Create(); });
    var sidShort = sid[..8];
    if (isNew)
        Log($"SESSION NEW sid={sidShort}… from {ip}");
    else
        Log($"SESSION RECONNECT sid={sidShort}… from {ip}");
    await session.Attach(ws, sm, sidShort, ip, Log);
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
    readonly DateTime _createdAt = DateTime.Now;
    int _inputCount;
    string? _kind;
    string? _label;
    string? _color;
    string? _projectId;

    public static Session Create(string? kind = null, string? label = null, string? color = null, string? projectId = null)
        => new Session { _kind = kind, _label = label, _color = color, _projectId = projectId };

    public string Stats
    {
        get
        {
            var dur = DateTime.Now - _createdAt;
            return $"age={FormatDuration(dur)}, inputs={_inputCount}";
        }
    }

    static string FormatDuration(TimeSpan ts)
    {
        if (ts.TotalDays >= 1) return $"{(int)ts.TotalDays}d{ts.Hours}h{ts.Minutes}m";
        if (ts.TotalHours >= 1) return $"{(int)ts.TotalHours}h{ts.Minutes}m";
        return $"{(int)ts.TotalMinutes}m{ts.Seconds}s";
    }

    public bool IsLaunched { get { lock (_lock) return _launched; } }
    public string? Kind { get { lock (_lock) return _kind; } }
    public string? Label { get { lock (_lock) return _label; } }
    public string? Color { get { lock (_lock) return _color; } }
    public string? ProjectId { get { lock (_lock) return _projectId; } }
    public bool HasWebSocket { get { lock (_lock) return _current != null; } }

    public void Launch(string kind, string? projectId, SettingsManager sm, string sidShort, Action<string> log, string? defaultCommand = null)
    {
        lock (_lock)
        {
            if (_launched) return;
            _launched = true;
            _kind ??= kind;
            _projectId ??= projectId;
        }
        var ps = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        string cwd;
        string[] cmd;

        var rmPsrl = "Remove-Module PSReadLine -ErrorAction SilentlyContinue;";

        if (kind == "powershell")
        {
            cwd = home;
            cmd = ["-NoExit", "-Command", rmPsrl];
        }
        else
        {
            var current = sm.Load();
            var project = current.Projects.FirstOrDefault(p => p.Id == projectId);
            cwd = project?.Directory ?? home;
            var claudeCmd = kind == "claude-resume" ? "claude --resume" : "claude";
            cmd = ["-NoExit", "-Command", $"{rmPsrl} {claudeCmd}"];
        }

        log($"SESSION LAUNCH sid={sidShort}… kind={kind} cwd={cwd}");

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

        if (!string.IsNullOrEmpty(defaultCommand))
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(500);
                var bytes = System.Text.Encoding.UTF8.GetBytes(defaultCommand + "\r");
                await Pty.WriterStream.WriteAsync(bytes);
                await Pty.WriterStream.FlushAsync();
            });
        }
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

    public async Task Attach(WebSocket ws, SettingsManager sm, string sidShort, string ip, Action<string> log)
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
            log($"WS REPLACED sid={sidShort}… old connection closed");
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
                            string? defCmd = null;
                            if (root.TryGetProperty("defaultCommand", out var dc) && dc.ValueKind == JsonValueKind.String)
                                defCmd = dc.GetString();
                            string? labelVal = null;
                            if (root.TryGetProperty("label", out var lblProp) && lblProp.ValueKind == JsonValueKind.String)
                                labelVal = lblProp.GetString();
                            string? colorVal = null;
                            if (root.TryGetProperty("color", out var clrProp) && clrProp.ValueKind == JsonValueKind.String)
                                colorVal = clrProp.GetString();
                            lock (_lock) { _label ??= labelVal; _color ??= colorVal; }
                            Launch(lk.GetString()!, projId, sm, sidShort, log, defCmd);
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
                Interlocked.Increment(ref _inputCount);
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
            log($"WS DISCONNECTED sid={sidShort}… from {ip} ({Stats})");
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

    [JsonPropertyName("mcpKeyProtected")]
    public string? McpKeyProtected { get; set; }
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

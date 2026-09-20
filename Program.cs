using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
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

var bootId = Guid.NewGuid().ToString("N");

const int HttpsPort = 7681;       // TLS, bound on all interfaces (browser + remote)
const int LoopbackHttpPort = 7680; // plain HTTP, loopback only (local notify hook + claude mcp add)

var authedIps = new System.Collections.Concurrent.ConcurrentDictionary<string, byte>();

var cert = GetOrCreateCert(sm, settings);

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(o =>
{
    // HTTPS on every interface — all network-facing traffic (Basic-auth creds, WebSocket) is encrypted.
    o.ListenAnyIP(HttpsPort, lo => lo.UseHttps(cert));
    // Plain HTTP bound to loopback only — never reaches the wire, so a self-signed cert isn't needed.
    // Used by the Claude notify hook (Windows PowerShell 5.1 can't skip cert validation) and local `claude mcp add`.
    o.ListenLocalhost(LoopbackHttpPort);
});
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
    if (ctx.Request.Path == "/mcp" || ctx.Request.Path == "/api/notify")
    {
        await next();
        return;
    }
    if (!TokensEqual(ctx.Request.Headers.Authorization.ToString(), expected))
    {
        var ip = GetClientIp(ctx);
        Log($"AUTH DENIED from {ip} — {ctx.Request.Method} {ctx.Request.Path}");
        ctx.Response.Headers["WWW-Authenticate"] = "Basic realm=\"webterm\"";
        ctx.Response.StatusCode = 401;
        return;
    }
    var okIp = GetClientIp(ctx);
    if (authedIps.TryAdd(okIp, 0))
        Log($"AUTH OK from {okIp}");
    await next();
});

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(20),
    KeepAliveTimeout = TimeSpan.FromSeconds(30)
});

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        ctx.Context.Response.Headers["Pragma"] = "no-cache";
        ctx.Context.Response.Headers["Expires"] = "0";
    }
});

var sessions = new ConcurrentDictionary<string, Session>();
var sseClients = new ConcurrentDictionary<string, Channel<string>>();
var pendingFiles = new ConcurrentDictionary<string, string>(); // id -> absolute host path

static (string contentType, string kind) FileMeta(string path)
{
    var ext = Path.GetExtension(path).ToLowerInvariant();
    return ext switch
    {
        ".png" => ("image/png", "image"),
        ".jpg" or ".jpeg" => ("image/jpeg", "image"),
        ".gif" => ("image/gif", "image"),
        ".webp" => ("image/webp", "image"),
        ".bmp" => ("image/bmp", "image"),
        ".svg" => ("image/svg+xml", "image"),
        ".mp4" => ("video/mp4", "video"),
        ".webm" => ("video/webm", "video"),
        ".mov" => ("video/quicktime", "video"),
        ".mkv" => ("video/x-matroska", "video"),
        ".m4v" => ("video/x-m4v", "video"),
        ".mp3" => ("audio/mpeg", "audio"),
        ".wav" => ("audio/wav", "audio"),
        ".ogg" => ("audio/ogg", "audio"),
        ".m4a" => ("audio/mp4", "audio"),
        ".flac" => ("audio/flac", "audio"),
        _ => ("application/octet-stream", "other")
    };
}

const int MaxUploadBytes = 20 * 1024 * 1024;
const string UploadSubdir = ".webterm";

// Where files pasted/dropped in the browser land. Inside the tab's project so the
// path handed to Claude sits under its cwd (no Read permission prompt); tabs with
// no project (PowerShell) fall back to a temp folder.
string UploadDirFor(string? projectId)
{
    var dir = projectId is null
        ? null
        : sm.Load().Projects.FirstOrDefault(p => p.Id == projectId)?.Directory;

    if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
        return Path.Combine(Path.GetTempPath(), "webterm-uploads");

    // A .gitignore of "*" ignores itself too, so the whole folder stays invisible
    // to git without touching the project's own ignore rules.
    var root = Path.Combine(dir, UploadSubdir);
    var ignore = Path.Combine(root, ".gitignore");
    Directory.CreateDirectory(root);
    if (!File.Exists(ignore)) File.WriteAllText(ignore, "*\n");
    return Path.Combine(root, "uploads");
}

// Every directory the sweeper may hold files in, derived from settings each pass
// so projects added or removed between restarts are still covered.
IEnumerable<string> UploadDirs()
{
    yield return Path.Combine(Path.GetTempPath(), "webterm-uploads");
    foreach (var p in sm.Load().Projects)
        if (!string.IsNullOrWhiteSpace(p.Directory))
            yield return Path.Combine(p.Directory, UploadSubdir, "uploads");
}

static string ExtForContentType(string? contentType) => contentType switch
{
    "image/png" => ".png",
    "image/jpeg" => ".jpg",
    "image/gif" => ".gif",
    "image/webp" => ".webp",
    "image/bmp" => ".bmp",
    "image/svg+xml" => ".svg",
    _ => ".bin"
};

static string SanitizeStem(string s)
{
    var invalid = Path.GetInvalidFileNameChars();
    var sb = new StringBuilder();
    foreach (var ch in s)
        sb.Append(char.IsWhiteSpace(ch) || Array.IndexOf(invalid, ch) >= 0 ? '_' : ch);
    var name = sb.ToString().Trim('_', '.');
    if (name.Length > 60) name = name[..60];
    return name.Length == 0 ? "file" : name;
}

static string UniqueUploadPath(string dir, string? originalName, string? contentType)
{
    var ext = Path.GetExtension(originalName ?? "");
    if (string.IsNullOrEmpty(ext)) ext = ExtForContentType(contentType);

    // Clipboard screenshots arrive nameless or as a generic "image" — timestamp
    // them so consecutive pastes don't all collide on one name.
    var stem = Path.GetFileNameWithoutExtension(originalName ?? "");
    stem = string.IsNullOrWhiteSpace(stem) || stem.Equals("image", StringComparison.OrdinalIgnoreCase)
        ? $"paste-{DateTime.Now:yyyyMMdd-HHmmss}"
        : SanitizeStem(stem);

    var candidate = Path.Combine(dir, stem + ext);
    for (var i = 2; File.Exists(candidate); i++)
        candidate = Path.Combine(dir, $"{stem}-{i}{ext}");
    return candidate;
}

_ = Task.Run(async () =>
{
    while (true)
    {
        try
        {
            var cutoff = DateTime.UtcNow - TimeSpan.FromDays(1);
            foreach (var dir in UploadDirs())
            {
                if (!Directory.Exists(dir)) continue;
                foreach (var file in Directory.EnumerateFiles(dir))
                {
                    try
                    {
                        if (File.GetLastWriteTimeUtc(file) >= cutoff) continue;
                        File.Delete(file);
                        Log($"UPLOAD SWEPT {file}");
                    }
                    catch { }
                }
            }
        }
        catch { }
        await Task.Delay(TimeSpan.FromHours(1));
    }
});

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
            var shouldReap = kv.Value.IsIdleSince(cutoff) || kv.Value.PtyExited;
            if (shouldReap && sessions.TryRemove(kv.Key, out var s))
            {
                var reason = s.PtyExited ? "pty exited" : "idle 30m";
                Log($"SESSION REAPED sid={kv.Key[..8]}… ({reason}, {s.Stats})");
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
        defaultPowershellColor = current.DefaultPowershellColor,
        bootId
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

app.MapPost("/api/restart", () =>
{
    var baseDir = AppContext.BaseDirectory;
    string? projectDir = null;
    var dir = new DirectoryInfo(baseDir);
    while (dir != null)
    {
        if (dir.GetFiles("*.csproj").Length > 0) { projectDir = dir.FullName; break; }
        dir = dir.Parent;
    }
    if (projectDir == null)
        return Results.Problem("Cannot find project directory");

    var pid = Environment.ProcessId;
    var escaped = projectDir.Replace("'", "''");
    var script = $"while(Get-Process -Id {pid} -EA SilentlyContinue){{Start-Sleep -Milliseconds 500}}; Set-Location '{escaped}'; dotnet build; if($LASTEXITCODE -eq 0){{ dotnet run }}";
    Process.Start(new ProcessStartInfo
    {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -Command \"{script}\"",
        UseShellExecute = true,
        WindowStyle = ProcessWindowStyle.Minimized
    });

    Log("RESTART requested — spawned replacement, exiting");
    _ = Task.Run(async () =>
    {
        await Task.Delay(500);
        Environment.Exit(0);
    });

    return Results.Ok(new { restarting = true });
});

app.MapGet("/api/sessions", () =>
{
    var list = sessions.Where(kv => kv.Value.IsLaunched).Select(kv => new
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

app.MapGet("/api/file/{id}", (string id) =>
{
    if (!pendingFiles.TryGetValue(id, out var path) || !File.Exists(path))
        return Results.NotFound();

    var (contentType, kind) = FileMeta(path);
    // Range processing lets the browser seek in video/audio.
    return Results.File(path, contentType,
        fileDownloadName: kind == "other" ? Path.GetFileName(path) : null,
        enableRangeProcessing: true);
});

app.MapDelete("/api/file/{id}", (string id) =>
{
    pendingFiles.TryRemove(id, out _);
    return Results.NoContent();
});

app.MapPost("/api/upload", async (HttpContext ctx) =>
{
    if (!ctx.Request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart/form-data" });

    // Kestrel's 30 MB default would reject a multi-image drop before the handler
    // ever runs, hiding the real per-file limit enforced below.
    var sizeLimit = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
    if (sizeLimit is { IsReadOnly: false }) sizeLimit.MaxRequestBodySize = 128L * 1024 * 1024;

    var sid = ctx.Request.Query["sid"].ToString();
    var sidShort = sid.Length >= 8 ? sid[..8] : sid;
    sessions.TryGetValue(sid, out var session);

    var dir = UploadDirFor(session?.ProjectId);
    Directory.CreateDirectory(dir);

    var form = await ctx.Request.ReadFormAsync();
    var saved = new List<string>();
    foreach (var file in form.Files)
    {
        if (file.Length <= 0) continue;
        if (file.Length > MaxUploadBytes)
            return Results.BadRequest(new { error = $"{file.FileName} exceeds the {MaxUploadBytes / (1024 * 1024)} MB limit" });

        var path = UniqueUploadPath(dir, file.FileName, file.ContentType);
        await using (var fs = File.Create(path))
            await file.CopyToAsync(fs);
        saved.Add(path);
        Log($"UPLOAD sid={sidShort}… {Path.GetFileName(path)} ({file.Length / 1024} KB) -> {dir}");
    }

    return Results.Json(new { paths = saved });
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

app.MapPost("/api/notify", async (HttpContext ctx) =>
{
    var token = ExtractApiToken(ctx);
    var current = sm.Load();
    if (string.IsNullOrEmpty(current.McpKeyProtected) || string.IsNullOrEmpty(token))
    {
        ctx.Response.StatusCode = 401;
        return;
    }
    try
    {
        if (!TokensEqual(token, SettingsManager.Unprotect(current.McpKeyProtected)))
        {
            ctx.Response.StatusCode = 401;
            return;
        }
    }
    catch
    {
        ctx.Response.StatusCode = 401;
        return;
    }

    JsonElement body;
    try { body = await ctx.Request.ReadFromJsonAsync<JsonElement>(); }
    catch { ctx.Response.StatusCode = 400; return; }

    var sid = body.TryGetProperty("sid", out var s) ? s.GetString() : null;
    var evt = body.TryGetProperty("event", out var ev) ? ev.GetString() : null;
    if (string.IsNullOrEmpty(sid) || string.IsNullOrEmpty(evt))
    {
        ctx.Response.StatusCode = 400;
        return;
    }

    var sseEvent = evt switch
    {
        "permission_request" => "tab_attention",
        "stop" => "tab_idle",
        _ => (string?)null
    };
    if (sseEvent == null) { ctx.Response.StatusCode = 400; return; }

    BroadcastSse(sseEvent, new { sid, @event = evt });
    Log($"NOTIFY sid={sid[..Math.Min(8, sid.Length)]}… event={evt}");
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

    var claudeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
    var hooksDirPath = Path.Combine(claudeDir, "hooks");
    Directory.CreateDirectory(hooksDirPath);
    var hookScriptPath = Path.Combine(hooksDirPath, "webterm-notify.ps1");
    File.WriteAllText(hookScriptPath, $$"""
        $sid = $env:WEBTERM_SID
        $token = $env:WEBTERM_NOTIFY_TOKEN
        if (-not $sid -or -not $token) { exit 0 }
        $eventType = $args[0]
        if (-not $eventType) { exit 0 }
        $body = "{`"sid`":`"$sid`",`"event`":`"$eventType`"}"
        try {
            # Loopback-only HTTP port: token never hits the wire, so no TLS / cert handling needed (works on Windows PowerShell 5.1).
            Invoke-RestMethod -Uri "http://127.0.0.1:{{LoopbackHttpPort}}/api/notify" -Method POST -Headers @{ Authorization = "Bearer $token" } -Body $body -ContentType 'application/json' -TimeoutSec 2 2>$null | Out-Null
        } catch {}
        """);

    try
    {
        var claudeSettingsPath = Path.Combine(claudeDir, "settings.json");
        JsonObject claudeSettings;
        if (File.Exists(claudeSettingsPath))
            claudeSettings = JsonNode.Parse(File.ReadAllText(claudeSettingsPath))?.AsObject() ?? new JsonObject();
        else
            claudeSettings = new JsonObject();

        var hooksObj = claudeSettings["hooks"]?.AsObject();
        if (hooksObj == null)
        {
            hooksObj = new JsonObject();
            claudeSettings["hooks"] = hooksObj;
        }

        var hookCmd = $"powershell.exe -ExecutionPolicy Bypass -File \"{hookScriptPath}\"";

        void AddHookIfMissing(string eventName, string arg)
        {
            var fullCmd = $"{hookCmd} {arg}";
            var arr = hooksObj[eventName]?.AsArray();
            if (arr != null)
            {
                foreach (var group in arr)
                {
                    var inner = group?["hooks"]?.AsArray();
                    if (inner != null)
                        foreach (var h in inner)
                            if (h?["command"]?.GetValue<string>()?.Contains("webterm-notify") == true)
                                return;
                }
            }
            else
            {
                arr = new JsonArray();
                hooksObj[eventName] = arr;
            }
            arr.Add(new JsonObject
            {
                ["matcher"] = "*",
                ["hooks"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["type"] = "command",
                        ["command"] = fullCmd,
                        ["timeout"] = 10
                    }
                }
            });
        }

        AddHookIfMissing("PermissionRequest", "permission_request");
        AddHookIfMissing("Stop", "stop");

        File.WriteAllText(claudeSettingsPath, claudeSettings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Log("Claude hooks configured for WebTerm notifications");
    }
    catch (Exception ex)
    {
        Log($"Failed to configure Claude hooks: {ex.Message}");
    }

    // Loopback HTTP + Bearer header: token stays off the wire and out of the URL (so it doesn't land in logs/history).
    var url = $"http://127.0.0.1:{LoopbackHttpPort}/mcp";
    // Remove any existing registration first so re-running setup updates the token/url cleanly. `;` continues even if remove fails (not registered).
    // Single-quote the sid header so PowerShell passes ${WEBTERM_SID} literally to claude, which expands it per-session at config load.
    // ${WEBTERM_SID:-} keeps config parseable when the var is unset (claude run outside a webterm tab) — server then falls back to default cwd.
    var command = $"claude mcp remove webterm -s user 2>$null; claude mcp add webterm --transport http \"{url}\" --header \"Authorization: Bearer {mcpKey}\" --header 'X-Webterm-Sid: ${{WEBTERM_SID:-}}' -s user";
    return Results.Json(new { command, url });
});

app.MapPost("/mcp", async (HttpContext ctx) =>
{
    var token = ExtractApiToken(ctx);
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
        if (!TokensEqual(token, expectedKey))
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
    var callerSid = ctx.Request.Headers["X-Webterm-Sid"].FirstOrDefault();

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
                    new { type = "object", properties = new Dictionary<string, object>() }),
                McpToolDef("restart",
                    "Rebuild and restart the WebTerm server. Kills all sessions.",
                    new { type = "object", properties = new Dictionary<string, object>() }),
                McpToolDef("show_file",
                    "Display a file from a host file path in the WebTerm browser. Images and videos render in an overlay viewer; other file types show a download link. The file is served from disk on demand and is not copied or deleted.",
                    new
                    {
                        type = "object",
                        properties = new Dictionary<string, object>
                        {
                            ["path"] = new { type = "string", description = "Absolute path to the file on the host computer" },
                            ["caption"] = new { type = "string", description = "Optional caption shown under the file" }
                        },
                        required = new[] { "path" }
                    }),
                McpToolDef("copy_text",
                    "Copy text to the clipboard of the device viewing WebTerm in a browser. The browser tries a silent clipboard write; if the browser blocks that (page not focused, Safari/iOS), it shows the text with a Copy button the user can tap. Max 1 MB.",
                    new
                    {
                        type = "object",
                        properties = new Dictionary<string, object>
                        {
                            ["text"] = new { type = "string", description = "The text to place on the clipboard" },
                            ["label"] = new { type = "string", description = "Optional short description shown in the browser notification (e.g. 'SQL query', 'commit message')" }
                        },
                        required = new[] { "text" }
                    })
            }
        }),
        "tools/call" => McpHandleToolCall(req, id, callerSid),
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

object McpHandleToolCall(JsonElement req, JsonElement? id, string? callerSid)
{
    var toolName = req.GetProperty("params").GetProperty("name").GetString();
    var args = req.GetProperty("params").TryGetProperty("arguments", out var a) ? a : default;

    return toolName switch
    {
        "open_tab" => McpOpenTab(id, args, callerSid),
        "close_tab" => McpCloseTab(id, args),
        "list_tabs" => McpListTabs(id),
        "restart" => McpRestart(id),
        "show_file" => McpShowFile(id, args),
        "copy_text" => McpCopyText(id, args),
        _ => McpError(id, -32602, $"Unknown tool: {toolName}")
    };
}

object McpOpenTab(JsonElement? id, JsonElement args, string? callerSid)
{
    var kind = args.TryGetProperty("kind", out var k) ? k.GetString() ?? "powershell" : "powershell";
    var projectId = args.TryGetProperty("projectId", out var p) ? p.GetString() : null;
    var label = args.TryGetProperty("label", out var l) ? l.GetString() : kind;
    var command = args.TryGetProperty("command", out var c) ? c.GetString() : null;

    // Default to the calling Claude's own project when caller didn't specify one.
    // Caller sid arrives via the X-Webterm-Sid header (expanded from ${WEBTERM_SID} per session).
    if (projectId == null && !string.IsNullOrEmpty(callerSid) && sessions.TryGetValue(callerSid, out var caller))
        projectId = caller.ProjectId;

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
    session.Launch(kind, projectId, sm, sid, sidShort, Log, command);

    BroadcastSse("tab_opened", new { sid, kind, label, color, projectId });
    Log($"MCP OPEN sid={sidShort}… kind={kind} label={label}");

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = $"Tab opened: sid={sid}, kind={kind}, label={label}" } }
    });
}

object McpShowFile(JsonElement? id, JsonElement args)
{
    var path = args.TryGetProperty("path", out var p) ? p.GetString() : null;
    var caption = args.TryGetProperty("caption", out var c) ? c.GetString() : null;

    if (string.IsNullOrWhiteSpace(path))
        return McpError(id, -32602, "Missing required parameter: path");

    var full = Path.GetFullPath(path);
    if (!File.Exists(full))
        return McpResult(id, new
        {
            content = new[] { new { type = "text", text = $"File not found: {full}" } },
            isError = true
        });

    var fileId = Guid.NewGuid().ToString();
    pendingFiles[fileId] = full;

    // Cap retained references so old entries don't accumulate.
    while (pendingFiles.Count > 50)
    {
        var oldest = pendingFiles.Keys.FirstOrDefault();
        if (oldest == null || oldest == fileId) break;
        pendingFiles.TryRemove(oldest, out _);
    }

    var name = Path.GetFileName(full);
    var (_, kind) = FileMeta(full);
    BroadcastSse("show_file", new { id = fileId, name, caption, kind });
    Log($"MCP SHOW_FILE id={fileId[..8]}… kind={kind} name={name}");

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = $"File displayed ({kind}): {name}" } }
    });
}

object McpCopyText(JsonElement? id, JsonElement args)
{
    var text = args.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
    var label = args.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() : null;

    if (text == null)
        return McpError(id, -32602, "Missing required parameter: text");

    const int maxChars = 1024 * 1024;
    if (text.Length > maxChars)
        return McpResult(id, new
        {
            content = new[] { new { type = "text", text = $"Text too large ({text.Length} chars); limit is {maxChars}" } },
            isError = true
        });

    if (sseClients.IsEmpty)
        return McpResult(id, new
        {
            content = new[] { new { type = "text", text = "No browser is connected to WebTerm, so nothing was copied" } },
            isError = true
        });

    BroadcastSse("copy_text", new { text, label });
    Log($"MCP COPY_TEXT chars={text.Length} label={label ?? "-"} browsers={sseClients.Count}");

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = $"Sent {text.Length} chars to {sseClients.Count} connected browser(s). The user gets a Copy button if their browser blocked the silent write." } }
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

object McpRestart(JsonElement? id)
{
    var baseDir = AppContext.BaseDirectory;
    string? projectDir = null;
    var dir = new DirectoryInfo(baseDir);
    while (dir != null)
    {
        if (dir.GetFiles("*.csproj").Length > 0) { projectDir = dir.FullName; break; }
        dir = dir.Parent;
    }
    if (projectDir == null)
        return McpError(id, -32603, "Cannot find project directory");

    var pid = Environment.ProcessId;
    var escaped = projectDir.Replace("'", "''");
    var script = $"while(Get-Process -Id {pid} -EA SilentlyContinue){{Start-Sleep -Milliseconds 500}}; Set-Location '{escaped}'; dotnet build; if($LASTEXITCODE -eq 0){{ dotnet run }}";
    Process.Start(new ProcessStartInfo
    {
        FileName = "powershell.exe",
        Arguments = $"-NoProfile -Command \"{script}\"",
        UseShellExecute = true,
        WindowStyle = ProcessWindowStyle.Minimized
    });

    Log("RESTART requested via MCP — spawned replacement, exiting");
    _ = Task.Run(async () =>
    {
        await Task.Delay(500);
        Environment.Exit(0);
    });

    return McpResult(id, new
    {
        content = new[] { new { type = "text", text = "WebTerm restarting…" } }
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
    await session.Attach(ws, sm, sid, sidShort, ip, Log);
});

app.Lifetime.ApplicationStarted.Register(() =>
{
    try
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = $"https://localhost:{HttpsPort}",
            UseShellExecute = true
        });
    }
    catch { }
});

app.Run();

// Pull the API token from an Authorization: Bearer header. Header-only by design — keeps the token
// out of URLs (and therefore out of access logs / shell history). Re-run "Add MCP" to reconfigure.
static string? ExtractApiToken(HttpContext ctx)
{
    var auth = ctx.Request.Headers.Authorization.ToString();
    if (!auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
    var t = auth["Bearer ".Length..].Trim();
    return string.IsNullOrEmpty(t) ? null : t;
}

static bool TokensEqual(string a, string b)
    => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

// Load the persisted self-signed cert from settings (DPAPI-protected PFX), or mint a fresh one.
static X509Certificate2 GetOrCreateCert(SettingsManager sm, WebtermSettings settings)
{
    if (!string.IsNullOrEmpty(settings.TlsCertProtected))
    {
        try
        {
            var stored = Convert.FromBase64String(SettingsManager.Unprotect(settings.TlsCertProtected));
            var existing = X509CertificateLoader.LoadPkcs12(stored, null, X509KeyStorageFlags.Exportable);
            if (existing.NotAfter > DateTime.Now.AddDays(7)) return existing;
        }
        catch { /* corrupt or expiring — fall through and regenerate */ }
    }

    var host = Environment.MachineName;
    using var rsa = RSA.Create(2048);
    var req = new CertificateRequest($"CN={host}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
    req.CertificateExtensions.Add(new X509KeyUsageExtension(
        X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
    req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
        new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false)); // serverAuth
    var san = new SubjectAlternativeNameBuilder();
    san.AddDnsName(host);
    san.AddDnsName("localhost");
    san.AddIpAddress(IPAddress.Loopback);
    req.CertificateExtensions.Add(san.Build());

    var generated = req.CreateSelfSigned(DateTimeOffset.Now.AddDays(-1), DateTimeOffset.Now.AddYears(5));
    var pfx = generated.Export(X509ContentType.Pfx);
    settings.TlsCertProtected = SettingsManager.Protect(Convert.ToBase64String(pfx));
    sm.Save(settings);
    // Reload from the exported PFX so Kestrel gets a cert with a usable private key on Windows.
    return X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.Exportable);
}

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
    bool _ptyExited;
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
    public bool PtyExited { get { lock (_lock) return _ptyExited; } }

    public void Launch(string kind, string? projectId, SettingsManager sm, string sid, string sidShort, Action<string> log, string? defaultCommand = null)
    {
        lock (_lock)
        {
            if (_launched) return;
            _launched = true;
            _kind ??= kind;
            _projectId ??= projectId;
        }
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        string app;
        string cwd;
        string[] cmd;

        if (kind == "powershell")
        {
            app = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            cwd = home;
            cmd = ["-NoProfile", "-NoLogo", "-NoExit"];
        }
        else
        {
            app = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            var current = sm.Load();
            var project = current.Projects.FirstOrDefault(p => p.Id == projectId);
            cwd = project?.Directory ?? home;
            cmd = kind == "claude-resume" ? ["/K", "claude", "--resume"] : ["/K", "claude"];
        }

        log($"SESSION LAUNCH sid={sidShort}… kind={kind} cwd={cwd}");

        var env = new Dictionary<string, string>();
        if (kind != "powershell")
        {
            foreach (System.Collections.DictionaryEntry de in System.Environment.GetEnvironmentVariables())
                env[(string)de.Key] = de.Value?.ToString() ?? "";
            env["WEBTERM_SID"] = sid;
            var cs = sm.Load();
            if (!string.IsNullOrEmpty(cs.McpKeyProtected))
            {
                try { env["WEBTERM_NOTIFY_TOKEN"] = SettingsManager.Unprotect(cs.McpKeyProtected); }
                catch { }
            }
        }

        var opts = new PtyOptions
        {
            Name = "xterm-256color",
            Cols = _cols,
            Rows = _rows,
            Cwd = cwd,
            App = app,
            CommandLine = cmd,
            Environment = env
        };
        Pty = PtyProvider.SpawnAsync(opts, CancellationToken.None).GetAwaiter().GetResult();
        _ = Task.Run(ReadLoop);

        if (!string.IsNullOrEmpty(defaultCommand))
        {
            // Wait for the shell/TUI to boot its input loop before sending; an early send gets swallowed.
            _ = Task.Run(async () =>
            {
                await Task.Delay(6000);
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

        WebSocket? ws;
        lock (_lock)
        {
            _ptyExited = true;
            ws = _current;
        }
        if (ws != null)
        {
            var exitMsg = Encoding.UTF8.GetBytes("{\"ptyExited\":true}");
            try { await ws.SendAsync(exitMsg, WebSocketMessageType.Text, true, default); } catch { }
            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "pty-exited", default); } catch { }
        }
    }

    public async Task Attach(WebSocket ws, SettingsManager sm, string sid, string sidShort, string ip, Action<string> log)
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
            using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await old.CloseAsync(WebSocketCloseStatus.NormalClosure, "replaced", closeCts.Token); } catch { }
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
            else if (PtyExited)
            {
                var msg = Encoding.UTF8.GetBytes("{\"ptyExited\":true}");
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
                            Launch(lk.GetString()!, projId, sm, sid, sidShort, log, defCmd);
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

    [JsonPropertyName("tlsCertProtected")]
    public string? TlsCertProtected { get; set; }
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
    public List<string> Order { get; set; } = ["enter", "tab", "up", "down", "left", "right", "ctrl-c", "esc", "shift-tab", "ctrl-b", "ctrl-o", "clr", "cmpt", "model", "effort"];

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

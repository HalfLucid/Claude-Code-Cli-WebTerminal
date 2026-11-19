using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

/// <summary>
/// One display entry of a Claude conversation, distilled from its .jsonl log.
/// K: user | assistant | cmd | out | tool | result | compact | note.
/// </summary>
sealed record TranscriptItem(string K, string? Text = null, string? Name = null, string? Arg = null, string? Id = null, bool? Err = null);

/// <summary>
/// Reads the conversation log Claude Code writes for every session
/// (~/.claude/projects/&lt;encoded cwd&gt;/&lt;session id&gt;.jsonl). Unlike the PTY
/// stream, it holds the text itself rather than screen drawing laid out for
/// one width, so the browser can show history that reflows to any width.
/// The format is internal to Claude Code: unknown entries are skipped.
/// </summary>
static class Transcript
{
    public static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // Caps keep a huge log (pasted files, long tool output) from shipping
    // megabytes of output nobody reads to the browser.
    const int MaxText = 100_000, MaxToolText = 4_000, MaxResultText = 6_000, MaxArg = 200;
    // Items sent for one read; older ones are dropped behind a note.
    const int MaxItems = 5_000;

    public static string ProjectsRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "projects");

    /// <summary>True for a .jsonl file under ~/.claude/projects (the only files served).</summary>
    public static bool IsValidPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        try
        {
            var full = Path.GetFullPath(path);
            return full.StartsWith(ProjectsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                   && full.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    // Claude names a project's log folder after its cwd with every
    // non-alphanumeric character replaced: C:\Dev\webterm -> C--Dev-webterm.
    static string ProjectFolder(string cwd) =>
        Path.Combine(ProjectsRoot, Regex.Replace(cwd.TrimEnd('\\', '/'), "[^a-zA-Z0-9]", "-"));

    /// <summary>
    /// Fallback when no hook has reported the session's log: the newest log in the
    /// cwd's project folder written since launch and not claimed by another tab.
    /// Keeps <paramref name="current"/> unless a newer log was created after it
    /// (/clear starts a new file). Can pick a Claude running outside WebTerm in
    /// the same folder; the SessionStart hook reports the exact file.
    /// </summary>
    public static string? Guess(string cwd, DateTime launchedUtc, string? current, ISet<string> claimed)
    {
        var dir = ProjectFolder(cwd);
        if (!Directory.Exists(dir)) return null;
        FileInfo[] files;
        try { files = new DirectoryInfo(dir).GetFiles("*.jsonl"); }
        catch { return current; }
        var since = launchedUtc.AddMinutes(-1);
        var candidates = files.Where(f => f.LastWriteTimeUtc >= since && !claimed.Contains(f.FullName)).ToList();
        if (current != null && File.Exists(current) && !claimed.Contains(current))
        {
            var created = File.GetCreationTimeUtc(current);
            var newer = candidates.Where(f => f.CreationTimeUtc > created && f.CreationTimeUtc >= since)
                                  .OrderByDescending(f => f.CreationTimeUtc).FirstOrDefault();
            return newer?.FullName ?? current;
        }
        return candidates.OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault()?.FullName;
    }

    /// <summary>
    /// Parses complete lines from byte offset <paramref name="from"/>. Returns the
    /// offset just past the last complete line (a line Claude is still writing is
    /// left for the next read) and whether the read restarted at 0 because the
    /// file is shorter than <paramref name="from"/>.
    /// </summary>
    public static (long Offset, List<TranscriptItem> Items, bool Restarted) Read(string path, long from)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var restarted = false;
        if (from < 0 || from > fs.Length) { from = 0; restarted = true; }
        fs.Seek(from, SeekOrigin.Begin);

        // Streamed in chunks, so the first open of a long conversation doesn't
        // hold the whole log in memory; only a line split across chunks is copied.
        var items = new List<TranscriptItem>();
        var buf = new byte[1 << 16];
        var partial = new MemoryStream();
        long read = from, consumed = from;   // consumed: just past the last complete line
        var dropped = 0;
        int n;
        while ((n = fs.Read(buf, 0, buf.Length)) > 0)
        {
            var start = 0;
            int nl;
            while ((nl = Array.IndexOf(buf, (byte)'\n', start, n - start)) >= 0)
            {
                if (partial.Length > 0)
                {
                    partial.Write(buf, start, nl - start);
                    ParseLine(partial.GetBuffer().AsSpan(0, (int)partial.Length), items);
                    partial.SetLength(0);
                }
                else ParseLine(buf.AsSpan(start, nl - start), items);
                start = nl + 1;
                consumed = read + start;
            }
            if (start < n) partial.Write(buf, start, n - start);   // incomplete line, so far
            read += n;
            if (items.Count > 2 * MaxItems)
            {
                dropped += items.Count - MaxItems;
                items.RemoveRange(0, items.Count - MaxItems);
            }
        }

        if (items.Count > MaxItems)
        {
            dropped += items.Count - MaxItems;
            items.RemoveRange(0, items.Count - MaxItems);
        }
        if (dropped > 0) items.Insert(0, new TranscriptItem("note", $"{dropped} earlier entries not shown"));
        return (consumed, items, restarted);
    }

    static void ParseLine(ReadOnlySpan<byte> line, List<TranscriptItem> items)
    {
        if (line.IsEmpty) return;
        try
        {
            var reader = new Utf8JsonReader(line);
            using var doc = JsonDocument.ParseValue(ref reader);
            Process(doc.RootElement, items);
        }
        catch (JsonException) { }
    }

    static void Process(JsonElement o, List<TranscriptItem> items)
    {
        if (o.ValueKind != JsonValueKind.Object) return;
        var type = Str(o, "type");
        if (type == "system")
        {
            if (Str(o, "subtype") == "compact_boundary") items.Add(new("note", "Conversation compacted"));
            return;
        }
        // A message typed while Claude was busy is queued, then logged as an
        // attachment (not a user entry) when Claude takes it, mid-turn or after.
        // Only the user's own: agent and task notifications are queued the same way.
        if (type == "attachment")
        {
            if (Bool(o, "isSidechain") || !o.TryGetProperty("attachment", out var a) || Str(a, "type") != "queued_command") return;
            if (a.TryGetProperty("origin", out var origin) && Str(origin, "kind") is { } kind && kind != "human") return;
            if (!a.TryGetProperty("prompt", out var prompt)) return;
            if (prompt.ValueKind == JsonValueKind.String) UserText(prompt.GetString()!, items);
            else if (PlainText(prompt) is { Length: > 0 } text) items.Add(new("user", Clip(text, MaxText)));
            return;
        }
        if (type is not ("user" or "assistant") || Bool(o, "isSidechain")) return;
        if (!o.TryGetProperty("message", out var m) || m.ValueKind != JsonValueKind.Object
            || !m.TryGetProperty("content", out var c)) return;

        if (type == "user")
        {
            if (Bool(o, "isCompactSummary")) { items.Add(new("compact", Clip(PlainText(c), MaxText))); return; }
            if (Bool(o, "isMeta")) return;
            if (c.ValueKind == JsonValueKind.String) { UserText(c.GetString()!, items); return; }
            if (c.ValueKind != JsonValueKind.Array) return;
            foreach (var b in c.EnumerateArray())
            {
                switch (Str(b, "type"))
                {
                    case "text": UserText(Str(b, "text") ?? "", items); break;
                    case "image": items.Add(new("user", "[Image]")); break;
                    case "tool_result":
                        items.Add(new("result", Clip(ResultText(b), MaxResultText), Id: Str(b, "tool_use_id"),
                                      Err: Bool(b, "is_error") ? true : null));
                        break;
                }
            }
            return;
        }

        if (c.ValueKind == JsonValueKind.String) { AddAssistant(c.GetString()!, items); return; }
        if (c.ValueKind != JsonValueKind.Array) return;
        foreach (var b in c.EnumerateArray())
        {
            switch (Str(b, "type"))
            {
                case "text": AddAssistant(Str(b, "text") ?? "", items); break;
                case "tool_use":
                case "server_tool_use":
                    b.TryGetProperty("input", out var input);
                    items.Add(new("tool", Clip(InputText(input), MaxToolText), Name: Str(b, "name") ?? "tool",
                                  Arg: Clip(PrimaryArg(input), MaxArg), Id: Str(b, "id")));
                    break;
            }
        }
    }

    static void AddAssistant(string text, List<TranscriptItem> items)
    {
        if (!string.IsNullOrWhiteSpace(text)) items.Add(new("assistant", Clip(text, MaxText)));
    }

    static readonly Regex Reminder = new(@"<system-reminder>.*?</system-reminder>", RegexOptions.Singleline | RegexOptions.Compiled);
    static readonly Regex Tag = new(@"</?[a-z][a-z0-9-]*>", RegexOptions.Compiled);
    static readonly Regex Ansi = new(@"\x1b\[[0-9;?]*[ -/]*[@-~]", RegexOptions.Compiled);

    static string? Between(string s, string tag)
    {
        var open = $"<{tag}>";
        var i = s.IndexOf(open, StringComparison.Ordinal);
        if (i < 0) return null;
        i += open.Length;
        var j = s.IndexOf($"</{tag}>", i, StringComparison.Ordinal);
        return j < 0 ? s[i..] : s[i..j];
    }

    // A user entry is either typed text or one of Claude Code's wrapped records:
    // slash commands, `!` shell commands and their output, local command output.
    static void UserText(string raw, List<TranscriptItem> items)
    {
        var s = Reminder.Replace(raw, "").Trim();
        if (s.Length == 0) return;
        if (s.StartsWith("<local-command-caveat>", StringComparison.Ordinal)) return;
        if (Between(s, "command-name") is { } cmd)
        {
            items.Add(new("cmd", $"{cmd.Trim()} {Between(s, "command-args")?.Trim()}".Trim()));
            return;
        }
        if (Between(s, "bash-input") is { } bash) { items.Add(new("cmd", "! " + bash.Trim())); return; }
        if (s.StartsWith("<bash-stdout>", StringComparison.Ordinal) || s.StartsWith("<bash-stderr>", StringComparison.Ordinal)
            || s.StartsWith("<local-command-stdout>", StringComparison.Ordinal) || s.StartsWith("<local-command-stderr>", StringComparison.Ordinal))
        {
            var output = System.Net.WebUtility.HtmlDecode(Ansi.Replace(Tag.Replace(s, ""), "")).Trim();
            if (output.Length > 0) items.Add(new("out", Clip(output, MaxResultText)));
            return;
        }
        if (s.StartsWith("<task-notification>", StringComparison.Ordinal))
        {
            var summary = Between(s, "summary")?.Trim();
            items.Add(new("note", string.IsNullOrEmpty(summary) ? "Background task finished" : summary));
            return;
        }
        if (s.StartsWith("[Request interrupted", StringComparison.Ordinal)) { items.Add(new("note", s.Trim('[', ']'))); return; }
        items.Add(new("user", Clip(s, MaxText)));
    }

    static string PlainText(JsonElement c)
    {
        if (c.ValueKind == JsonValueKind.String) return Reminder.Replace(c.GetString()!, "").Trim();
        if (c.ValueKind != JsonValueKind.Array) return "";
        var sb = new StringBuilder();
        foreach (var b in c.EnumerateArray())
            if (Str(b, "type") == "text") sb.Append(Str(b, "text")).Append('\n');
        return Reminder.Replace(sb.ToString(), "").Trim();
    }

    static string ResultText(JsonElement b)
    {
        if (!b.TryGetProperty("content", out var c)) return "";
        if (c.ValueKind == JsonValueKind.String) return Ansi.Replace(Reminder.Replace(c.GetString()!, ""), "").Trim();
        if (c.ValueKind != JsonValueKind.Array) return "";
        var sb = new StringBuilder();
        foreach (var x in c.EnumerateArray())
        {
            switch (Str(x, "type"))
            {
                case "text": sb.Append(Str(x, "text")).Append('\n'); break;
                case "image": sb.Append("[Image]\n"); break;
                case "tool_reference": sb.Append("Loaded tool: ").Append(Str(x, "tool_name")).Append('\n'); break;
            }
        }
        return Ansi.Replace(Reminder.Replace(sb.ToString(), ""), "").Trim();
    }

    // The argument shown in the collapsed `Name(arg)` header.
    static readonly string[] PrimaryKeys = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"];

    static string? PrimaryArg(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object) return null;
        foreach (var k in PrimaryKeys)
            if (input.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s)
                return s.ReplaceLineEndings(" ");
        return null;
    }

    static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    static string InputText(JsonElement input)
    {
        if (input.ValueKind == JsonValueKind.Undefined) return "";
        // A lone command reads better bare than as JSON.
        if (input.ValueKind == JsonValueKind.Object && input.TryGetProperty("command", out var cmd)
            && cmd.ValueKind == JsonValueKind.String && input.EnumerateObject().Count(p => p.Name is not ("description" or "timeout")) == 1)
            return cmd.GetString()!;
        return JsonSerializer.Serialize(input, Indented);
    }

    static string Clip(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s[..max] + $"\n… ({s.Length - max:N0} more characters)";
    }

    static string? Str(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static bool Bool(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}

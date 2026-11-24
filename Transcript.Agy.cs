using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

/// <summary>
/// agy (Antigravity CLI) conversation logs:
/// ~/.gemini/antigravity-cli/brain/&lt;conversation id&gt;/.system_generated/logs/transcript.jsonl,
/// one step per line ({step_index, source, type, status, content?, tool_calls?, error?}).
/// A PLANNER_RESPONSE's n tool calls are answered by the next n steps (GENERIC,
/// in call order), so call i of step k and its result share the id k+1+i
/// without any state carried between reads. The format is internal to agy:
/// unknown steps are skipped.
/// </summary>
static partial class Transcript
{
    public static string AgyBrainRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini", "antigravity-cli", "brain");

    const string AgyLogRel = ".system_generated\\logs\\transcript.jsonl";
    // What agy's hooks report: the same steps with tool output untruncated.
    const string AgyFullLogRel = ".system_generated\\logs\\transcript_full.jsonl";

    /// <summary>True for brain\&lt;id&gt;\.system_generated\logs\transcript(_full).jsonl (full path).</summary>
    static bool IsAgyPath(string path)
    {
        var root = AgyBrainRoot + Path.DirectorySeparatorChar;
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return false;
        var rel = path[root.Length..];
        var slash = rel.IndexOf(Path.DirectorySeparatorChar);
        return slash > 0 && (string.Equals(rel[(slash + 1)..], AgyLogRel, StringComparison.OrdinalIgnoreCase)
                             || string.Equals(rel[(slash + 1)..], AgyFullLogRel, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The log to serve for a reported path: agy's hooks report transcript_full.jsonl,
    /// whose tool outputs WebTerm clips anyway, so its smaller transcript.jsonl
    /// sibling is read instead when it exists. Any other path is returned as is.
    /// </summary>
    public static string Preferred(string path)
    {
        if (!IsAgyPath(path) || !path.EndsWith("transcript_full.jsonl", StringComparison.OrdinalIgnoreCase)) return path;
        var sibling = Path.Combine(Path.GetDirectoryName(path)!, "transcript.jsonl");
        return File.Exists(sibling) ? sibling : path;
    }

    /// <summary>
    /// The path a session's claim excludes from other tabs' guesses: an agy
    /// transcript_full.jsonl always maps to its transcript.jsonl sibling (what
    /// AgyGuess looks at), even before that file exists.
    /// </summary>
    public static string ClaimKey(string path) =>
        IsAgyPath(path) && path.EndsWith("transcript_full.jsonl", StringComparison.OrdinalIgnoreCase)
            ? Path.Combine(Path.GetDirectoryName(path)!, "transcript.jsonl")
            : path;

    // agy keeps every conversation in one folder, so the guess can't use the cwd;
    // the claimed set and the launch time keep two agy tabs apart.
    static string? AgyGuess(DateTime launchedUtc, string? current, ISet<string> claimed)
    {
        if (!Directory.Exists(AgyBrainRoot)) return null;
        List<FileInfo> files;
        try
        {
            // Every conversation's log: appending to it doesn't touch its brain\<id>
            // folder's write time, so the folders can't be pre-filtered (a resumed
            // conversation would be missed). Pick filters on the log's own time.
            files = new DirectoryInfo(AgyBrainRoot).GetDirectories()
                .Select(d => new FileInfo(Path.Combine(d.FullName, AgyLogRel)))
                .Where(f => f.Exists)
                .ToList();
        }
        catch { return current; }
        return Pick(files, launchedUtc, current, claimed);
    }

    static readonly Regex AgyTimes = new(@"^(?:(?:Created|Completed) At: [^\n]*\n)+", RegexOptions.Compiled);
    static readonly Regex AgyBlocks = new(@"<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>.*?</\1>", RegexOptions.Singleline | RegexOptions.Compiled);
    static readonly string[] AgyPrimaryKeys = ["CommandLine", "Path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "Query", "Url", "toolSummary"];

    static void ProcessAgy(JsonElement o, long at, List<TranscriptItem> items)
    {
        if (o.ValueKind != JsonValueKind.Object) return;
        long step = o.TryGetProperty("step_index", out var si) && si.ValueKind == JsonValueKind.Number && si.TryGetInt64(out var sv) ? sv : -1;
        switch (Str(o, "type"))
        {
            case "USER_INPUT":
            {
                if (Str(o, "content") is not { } c) return;
                var text = (Between(c, "USER_REQUEST") ?? AgyBlocks.Replace(c, "")).Trim();
                if (text.Length > 0) items.Add(new("user", Clip(text, MaxText)));
                return;
            }
            case "PLANNER_RESPONSE":
            {
                AddAssistant(Str(o, "content") ?? "", items);
                if (!o.TryGetProperty("tool_calls", out var calls) || calls.ValueKind != JsonValueKind.Array) return;
                var i = 0;
                foreach (var call in calls.EnumerateArray())
                {
                    var id = step >= 0 ? (step + 1 + i).ToString() : null;
                    i++;
                    var args = AgyArgs(call);
                    var primary = AgyPrimaryKeys.Select(k => args.GetValueOrDefault(k)).FirstOrDefault(v => !string.IsNullOrEmpty(v));
                    items.Add(new("tool", Clip(AgyInputText(args), MaxToolText), Name: Str(call, "name") ?? "tool",
                                  Arg: Clip(primary?.ReplaceLineEndings(" "), MaxArg), Id: id));
                }
                return;
            }
            case "GENERIC":
            {
                var err = Str(o, "status") == "ERROR";
                var content = AgyTimes.Replace((Str(o, "content") ?? "").ReplaceLineEndings("\n"), "");
                var text = err && Str(o, "error") is { Length: > 0 } e ? e : content;
                items.Add(new("result", Clip(Ansi.Replace(text, "").Trim(), MaxResultText),
                              Id: step >= 0 ? step.ToString() : null, Err: err ? true : null));
                return;
            }
            case "SYSTEM_MESSAGE":
            {
                // e.g. "[Message] timestamp=… sender=…/task-89 priority=… content=Task id "…" finished with result:"
                var c = Str(o, "content") ?? "";
                var k = c.IndexOf("content=", StringComparison.Ordinal);
                var line = (k >= 0 ? c[(k + "content=".Length)..] : "").Split('\n')[0].Trim();
                items.Add(new("note", line.Length > 0 ? Clip(line, MaxArg) : "System message"));
                return;
            }
        }
    }

    // agy logs each argument as a JSON-encoded string ("\"npm test\"", "5000"); decoded here.
    static Dictionary<string, string> AgyArgs(JsonElement call)
    {
        var args = new Dictionary<string, string>();
        if (!call.TryGetProperty("args", out var a) || a.ValueKind != JsonValueKind.Object) return args;
        foreach (var p in a.EnumerateObject())
        {
            string value;
            if (p.Value.ValueKind != JsonValueKind.String) value = p.Value.GetRawText();
            else
            {
                value = p.Value.GetString()!;
                try
                {
                    using var doc = JsonDocument.Parse(value);
                    value = doc.RootElement.ValueKind == JsonValueKind.String ? doc.RootElement.GetString()! : doc.RootElement.GetRawText();
                }
                catch (JsonException) { }
            }
            args[p.Name] = value;
        }
        return args;
    }

    // "Key: value" lines (multi-line values below their key), which read better
    // than JSON for edit_file's Target/Replacement; a lone command is shown bare.
    static string AgyInputText(Dictionary<string, string> args)
    {
        var shown = args.Where(kv => kv.Key is not ("toolSummary" or "WaitMsBeforeAsync")).ToList();
        if (shown.Count == 1 && shown[0].Key == "CommandLine") return shown[0].Value;
        var sb = new StringBuilder();
        foreach (var (k, v) in shown)
        {
            if (v.Contains('\n')) sb.Append(k).Append(":\n").Append(v.TrimEnd()).Append('\n');
            else sb.Append(k).Append(": ").Append(v).Append('\n');
        }
        return sb.ToString().TrimEnd();
    }
}

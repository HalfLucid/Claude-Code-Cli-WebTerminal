/// <summary>
/// An agent CLI WebTerm can launch in a tab. A tab's kind is the agent's Id, or
/// Id + "-resume" to continue its last conversation.
/// </summary>
/// <param name="Exe">Command run through cmd.exe /K (found on PATH by cmd).</param>
/// <param name="ResumeArgs">Arguments that continue the last conversation in the cwd.</param>
/// <param name="PromptArgs">Arguments placed before an initial prompt.</param>
/// <param name="ProcessNames">Image names of the agent's own process: a second one
/// between a hook and the tab's PTY means an agent started inside the tab.</param>
sealed record AgentDef(string Id, string Name, string Exe, string[] ResumeArgs, string[] PromptArgs, string[] ProcessNames)
{
    /// <summary>How to spawn the agent directly (no cmd.exe), args already quoted; null if not on PATH.</summary>
    public (string App, string[] Args)? Find() => Id == "claude" ? Agents.FindClaude() : Agents.FindExe(Exe + ".exe");

    /// <summary>Whether the command runs from a shell (any launcher on PATH), even when <see cref="Find"/> can't spawn it directly.</summary>
    public bool IsOnPath() => Find() != null || new[] { ".exe", ".cmd", ".bat", ".ps1" }.Any(ext => Agents.FindOnPath(Exe + ext) != null);
}

static class Agents
{
    public static readonly AgentDef Claude = new("claude", "Claude", "claude", ["--resume"], [], ["claude.exe", "node.exe"]);
    public static readonly AgentDef Agy = new("agy", "agy", "agy", ["--continue"], ["-i"], ["agy.exe"]);
    public static readonly AgentDef[] All = [Claude, Agy];

    public static AgentDef? Get(string? id) => All.FirstOrDefault(a => a.Id == id);

    /// <summary>The agent a tab kind launches, and whether it resumes; null for powershell or an unknown kind.</summary>
    public static (AgentDef Agent, bool Resume)? Parse(string? kind)
    {
        if (kind == null) return null;
        var resume = kind.EndsWith("-resume", StringComparison.Ordinal);
        var agent = Get(resume ? kind[..^"-resume".Length] : kind);
        return agent == null ? null : (agent, resume);
    }

    public static bool IsValidKind(string? kind) => kind == "powershell" || Parse(kind) != null;

    /// <summary>Every kind a tab can be opened with.</summary>
    public static string[] Kinds => ["powershell", .. All.SelectMany(a => new[] { a.Id, a.Id + "-resume" })];

    /// <summary>
    /// The native claude.exe, or for an npm install (claude.cmd shim) node.exe + the
    /// package's cli.js, which is what the shim runs.
    /// </summary>
    public static (string App, string[] Args)? FindClaude()
    {
        foreach (var dir in PathDirs())
        {
            var exe = Path.Combine(dir, "claude.exe");
            if (File.Exists(exe)) return (exe, []);
            if (File.Exists(Path.Combine(dir, "claude.cmd")))
            {
                var cli = Path.Combine(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
                var localNode = Path.Combine(dir, "node.exe");
                var node = File.Exists(localNode) ? localNode : FindOnPath("node.exe");
                if (File.Exists(cli) && node != null) return (node, [QuoteWindowsArg(cli)]);
            }
        }
        return null;
    }

    public static (string App, string[] Args)? FindExe(string file) =>
        FindOnPath(file) is { } exe ? (exe, []) : null;

    public static string? FindOnPath(string file) =>
        PathDirs().Select(d => Path.Combine(d, file)).FirstOrDefault(File.Exists);

    static IEnumerable<string> PathDirs()
    {
        foreach (var raw in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            string dir;
            try { dir = Path.GetFullPath(raw.Trim().Trim('"')); }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { continue; }
            yield return dir;
        }
    }

    /// <summary>An initial prompt as one argument; a leading space keeps one starting with '-' from parsing as an option.</summary>
    public static string QuotePrompt(string prompt) =>
        QuoteWindowsArg(prompt.StartsWith('-') ? " " + prompt : prompt);

    /// <summary>
    /// Quotes one argument so CommandLineToArgvW / the MSVC CRT parse it back byte-for-byte:
    /// backslashes are literal except before a quote, where they are doubled and the quote is escaped.
    /// </summary>
    public static string QuoteWindowsArg(string arg)
    {
        var sb = new System.Text.StringBuilder(arg.Length + 2).Append('"');
        int backslashes = 0;
        foreach (var ch in arg)
        {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"') sb.Append('\\', backslashes * 2 + 1);
            else sb.Append('\\', backslashes);
            sb.Append(ch);
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }
}

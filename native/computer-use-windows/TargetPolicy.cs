using System.IO;
using System.Text.RegularExpressions;

namespace T3Code.ComputerUse.Windows;

public static class TargetPolicy
{
    private static readonly HashSet<string> ForbiddenExecutables = new(
        [
            "cmd.exe",
            "alacritty.exe",
            "cmder.exe",
            "conemu.exe",
            "conemu64.exe",
            "conhost.exe",
            "hyper.exe",
            "kitty.exe",
            "mintty.exe",
            "openconsole.exe",
            "powershell.exe",
            "pwsh.exe",
            "rio.exe",
            "tabby.exe",
            "wezterm-gui.exe",
            "windowsterminal.exe",
            "wt.exe",
            "t3code.exe",
            "t3codecomputeruse.exe",
        ],
        StringComparer.OrdinalIgnoreCase
    );

    private static readonly Regex TerminalIdentityPattern = new(
        @"(?:^|[^a-z0-9])(terminal|console|shell|command\s*prompt|powershell|pwsh|cmd|rio)(?:[^a-z0-9]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    public static bool IsForbidden(string executablePath, string processName)
        =>
            IsForbidden(
                new TargetSecurityEvidence(
                    executablePath,
                    processName,
                    null,
                    null,
                    null,
                    null,
                    true,
                    []
                )
            );

    public static bool IsForbidden(TargetSecurityEvidence evidence)
    {
        var executableName = Path.GetFileName(evidence.ExecutablePath);
        return ForbiddenExecutables.Contains(executableName)
            || ForbiddenExecutables.Contains(evidence.ProcessName)
            || evidence.ProcessName.StartsWith("T3 Code", StringComparison.OrdinalIgnoreCase)
            || TerminalIdentityPattern.IsMatch(
                string.Join(
                    " ",
                    new[]
                    {
                        executableName,
                        evidence.ProcessName,
                        evidence.WindowTitle,
                        evidence.WindowClass,
                        evidence.FileDescription,
                        evidence.ProductName,
                    }.Where(value => !string.IsNullOrWhiteSpace(value))
                )
            )
            || evidence.SurfaceDescriptors.Any(TerminalIdentityPattern.IsMatch);
    }

    public static TargetClassification Classify(
        string executablePath,
        string processName,
        string? windowTitle
    )
    {
        var executableName = Path.GetFileName(executablePath);
        if (
            executableName.Equals("EXCEL.EXE", StringComparison.OrdinalIgnoreCase)
            || processName.Equals("EXCEL.EXE", StringComparison.OrdinalIgnoreCase)
            || processName.Equals("Microsoft Excel", StringComparison.OrdinalIgnoreCase)
        )
        {
            return new TargetClassification(
                "office-document",
                "office-accessibility",
                "excel",
                DocumentName(windowTitle, " - Excel")
            );
        }
        if (
            executableName.Equals("POWERPNT.EXE", StringComparison.OrdinalIgnoreCase)
            || processName.Equals("POWERPNT.EXE", StringComparison.OrdinalIgnoreCase)
            || processName.Equals("Microsoft PowerPoint", StringComparison.OrdinalIgnoreCase)
        )
        {
            return new TargetClassification(
                "office-document",
                "office-accessibility",
                "powerpoint",
                DocumentName(windowTitle, " - PowerPoint")
            );
        }
        return new TargetClassification("window", "native-accessibility", null, null);
    }

    public static bool MatchesRequestedKind(string? requestedKind, string targetKind) =>
        requestedKind is null || requestedKind.Equals(targetKind, StringComparison.Ordinal);

    private static string? DocumentName(string? title, string suffix)
    {
        var trimmed = title?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }
        if (trimmed.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            trimmed = trimmed[..^suffix.Length].Trim();
        }
        return string.IsNullOrEmpty(trimmed) ? null : trimmed[..Math.Min(trimmed.Length, 512)];
    }
}

public sealed record TargetSecurityEvidence(
    string ExecutablePath,
    string ProcessName,
    string? WindowTitle,
    string? WindowClass,
    string? FileDescription,
    string? ProductName,
    bool HasStructuredAccessibility,
    IReadOnlyList<string> SurfaceDescriptors
);

public sealed record TargetClassification(
    string Kind,
    string Integration,
    string? Application,
    string? DocumentName
);

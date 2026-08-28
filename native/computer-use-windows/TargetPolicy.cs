using System.IO;

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
            "tabby.exe",
            "wezterm-gui.exe",
            "windowsterminal.exe",
            "wt.exe",
            "t3code.exe",
            "t3codecomputeruse.exe",
        ],
        StringComparer.OrdinalIgnoreCase
    );

    public static bool IsForbidden(string executablePath, string processName)
    {
        var executableName = Path.GetFileName(executablePath);
        return ForbiddenExecutables.Contains(executableName)
            || ForbiddenExecutables.Contains(processName)
            || processName.StartsWith("T3 Code", StringComparison.OrdinalIgnoreCase);
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

public sealed record TargetClassification(
    string Kind,
    string Integration,
    string? Application,
    string? DocumentName
);

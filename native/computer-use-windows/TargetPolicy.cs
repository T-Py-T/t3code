using System.IO;

namespace T3Code.ComputerUse.Windows;

public static class TargetPolicy
{
    private static readonly HashSet<string> ForbiddenExecutables = new(
        [
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
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
}

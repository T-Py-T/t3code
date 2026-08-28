using System.Drawing;

namespace T3Code.ComputerUse.Windows;

public static class HostMath
{
    private const double MaximumScreenshotPixels = 2_000_000;
    private const double MaximumScreenshotEdge = 2_048;

    public static Size ScreenshotSize(int sourceWidth, int sourceHeight)
    {
        if (sourceWidth < 1 || sourceHeight < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(sourceWidth));
        }

        var scale = Math.Min(
            1,
            Math.Min(
                MaximumScreenshotEdge / sourceWidth,
                Math.Min(
                    MaximumScreenshotEdge / sourceHeight,
                    Math.Sqrt(MaximumScreenshotPixels / (sourceWidth * (double)sourceHeight))
                )
            )
        );
        return new Size(
            Math.Max(1, (int)Math.Floor(sourceWidth * scale)),
            Math.Max(1, (int)Math.Floor(sourceHeight * scale))
        );
    }

    public static IReadOnlyList<Point> Interpolate(
        Point from,
        Point to,
        int durationMilliseconds
    )
    {
        var boundedDuration = Math.Clamp(durationMilliseconds, 0, 60_000);
        var steps = boundedDuration == 0 ? 1 : Math.Clamp((boundedDuration + 15) / 16, 1, 3_750);
        var positions = new List<Point>(steps);
        for (var step = 1; step <= steps; step++)
        {
            var progress = step / (double)steps;
            positions.Add(
                new Point(
                    (int)Math.Round(from.X + (to.X - from.X) * progress),
                    (int)Math.Round(from.Y + (to.Y - from.Y) * progress)
                )
            );
        }

        return positions;
    }
}

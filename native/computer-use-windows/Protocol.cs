using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Nodes;

namespace T3Code.ComputerUse.Windows;

public sealed record HostRequest
{
    [JsonPropertyName("requestId")]
    public required string RequestId { get; init; }

    [JsonPropertyName("leaseId")]
    public required string LeaseId { get; init; }

    [JsonPropertyName("environmentId")]
    public required string EnvironmentId { get; init; }

    [JsonPropertyName("operation")]
    public required string Operation { get; init; }

    [JsonPropertyName("targetId")]
    public string? TargetId { get; init; }

    [JsonPropertyName("observationId")]
    public string? ObservationId { get; init; }

    [JsonPropertyName("input")]
    public required JsonElement Input { get; init; }

    [JsonPropertyName("timeoutMs")]
    public required int TimeoutMs { get; init; }
}

public sealed record HostErrorPayload
{
    public const int MaximumMessageLength = 4_096;

    [JsonPropertyName("_tag")]
    public required string Tag { get; init; }

    [JsonPropertyName("message")]
    public required string Message { get; init; }

    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonNode? Detail { get; init; }

    public static HostErrorPayload Create(string tag, string message, JsonNode? detail = null) =>
        new()
        {
            Tag = tag,
            Message = new string(message.Take(MaximumMessageLength).ToArray()),
            Detail = detail,
        };
}

public sealed record HostResponse
{
    [JsonPropertyName("requestId")]
    public required string RequestId { get; init; }

    [JsonPropertyName("leaseId")]
    public required string LeaseId { get; init; }

    [JsonPropertyName("ok")]
    public required bool Ok { get; init; }

    [JsonPropertyName("result")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonNode? Result { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public HostErrorPayload? Error { get; init; }

    public static HostResponse Success(HostRequest request, JsonNode result) =>
        new()
        {
            RequestId = request.RequestId,
            LeaseId = request.LeaseId,
            Ok = true,
            Result = result,
        };

    public static HostResponse Failure(HostRequest request, HostErrorPayload error) =>
        new()
        {
            RequestId = request.RequestId,
            LeaseId = request.LeaseId,
            Ok = false,
            Error = error,
        };
}

public static class HostCommandParser
{
    public static bool TryParse(
        string line,
        out HostRequest? request,
        out (string LeaseId, string Reason)? cancellation
    )
    {
        request = null;
        cancellation = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement))
            {
                return false;
            }

            switch (typeElement.GetString())
            {
                case "request" when root.TryGetProperty("request", out var requestElement):
                    request = requestElement.Deserialize<HostRequest>();
                    return request is not null;
                case "cancel"
                    when root.TryGetProperty("leaseId", out var leaseElement)
                        && root.TryGetProperty("reason", out var reasonElement):
                    {
                        var leaseId = leaseElement.GetString();
                        var reason = reasonElement.GetString();
                        if (string.IsNullOrWhiteSpace(leaseId) || string.IsNullOrWhiteSpace(reason))
                        {
                            return false;
                        }

                        cancellation = (leaseId, reason);
                        return true;
                    }
                default:
                    return false;
            }
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

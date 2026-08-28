import { EnvironmentId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { probeLocalComputerUseHostStatus } from "./LocalComputerUseHost.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.effect("probes permission state through the native helper identity", () =>
  Effect.gen(function* () {
    const inputs: Array<ProcessRunner.ProcessRunInput> = [];
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
      inputs.push(input);
      return Effect.succeed({
        stdout: encodeJson({
          requestId: "computer-use-status-probe",
          leaseId: "computer-use-status-probe",
          ok: true,
          result: {
            locked: false,
            permissions: {
              accessibility: "denied",
              screenCapture: "granted",
              input: "denied",
            },
          },
        }),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    };
    const status = yield* probeLocalComputerUseHostStatus(
      { command: "/signed/T3CodeComputerUse", args: [] },
      EnvironmentId.make("environment-1"),
    ).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
    );

    expect(status.permissions).toEqual({
      accessibility: "denied",
      screenCapture: "granted",
      input: "denied",
    });
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input).toBeDefined();
    expect(input).toMatchObject({
      command: "/signed/T3CodeComputerUse",
      args: [],
    });
    expect(input?.stdin).toContain('"operation":"status"');
  }),
);

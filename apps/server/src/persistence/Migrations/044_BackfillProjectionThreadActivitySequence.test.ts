import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_BackfillProjectionThreadActivitySequence", (it) => {
  it.effect("restores event order for legacy same-timestamp activities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            101,
            'event-progress',
            'thread',
            'thread-1',
            1,
            'thread.activity-appended',
            '2026-08-01T11:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'system',
            ${'{"threadId":"thread-1","activity":{"id":"z-progress"}}'},
            '{}'
          ),
          (
            102,
            'event-progress-latest',
            'thread',
            'thread-1',
            2,
            'thread.activity-appended',
            '2026-08-01T11:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'system',
            ${'{"threadId":"thread-1","activity":{"id":"z-progress"}}'},
            '{}'
          ),
          (
            103,
            'event-completed',
            'thread',
            'thread-1',
            3,
            'thread.activity-appended',
            '2026-08-01T11:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'system',
            ${'{"threadId":"thread-1","activity":{"id":"a-completed"}}'},
            '{}'
          ),
          (
            104,
            'event-tool',
            'thread',
            'thread-1',
            4,
            'thread.activity-appended',
            '2026-08-01T11:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'system',
            ${'{"threadId":"thread-1","activity":{"id":"tool-progress"}}'},
            '{}'
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'z-progress',
            'thread-1',
            NULL,
            'info',
            'task.progress',
            'Working',
            '{}',
            NULL,
            '2026-08-01T11:00:00.000Z'
          ),
          (
            'a-completed',
            'thread-1',
            NULL,
            'info',
            'task.completed',
            'Completed',
            '{}',
            NULL,
            '2026-08-01T11:00:00.000Z'
          ),
          (
            'tool-progress',
            'thread-1',
            NULL,
            'tool',
            'tool.updated',
            'Tool output',
            '{}',
            NULL,
            '2026-08-01T11:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly sequence: number | null;
      }>`
        SELECT
          activity_id AS "activityId",
          sequence
        FROM projection_thread_activities
        ORDER BY activity_id ASC
      `;
      assert.deepEqual(rows, [
        { activityId: "a-completed", sequence: 103 },
        { activityId: "tool-progress", sequence: null },
        { activityId: "z-progress", sequence: 102 },
      ]);
    }),
  );
});

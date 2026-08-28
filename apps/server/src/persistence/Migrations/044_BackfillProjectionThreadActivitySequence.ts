import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP TABLE IF EXISTS temp_projection_thread_activity_sequences
  `;

  yield* sql`
    CREATE TEMP TABLE temp_projection_thread_activity_sequences (
      activity_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO temp_projection_thread_activity_sequences (
      activity_id,
      sequence
    )
    SELECT
      json_extract(payload_json, '$.activity.id'),
      MAX(sequence)
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.id') IS NOT NULL
    GROUP BY json_extract(payload_json, '$.activity.id')
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET sequence = (
      SELECT mapped.sequence
      FROM temp_projection_thread_activity_sequences AS mapped
      WHERE mapped.activity_id = projection_thread_activities.activity_id
    )
    WHERE sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM temp_projection_thread_activity_sequences AS mapped
        WHERE mapped.activity_id = projection_thread_activities.activity_id
      )
  `;

  yield* sql`
    DROP TABLE temp_projection_thread_activity_sequences
  `;
});

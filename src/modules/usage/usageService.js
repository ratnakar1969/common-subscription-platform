
import pool from "../../config/database.js";
import logger from "../../config/logger.js";


// Records one successfully created HiringXChange job.
// jobId must be stable across retries.
async function recordJobPosted({ userId, jobId, occurredAt }) {
  if (!userId || !jobId) {
    throw new Error("userId and jobId are required");
  }
  logger.info(
  {
    operation: "record-job-posted",
    userId,
    jobId,
  },
  "Processing job-posted usage"
);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const eventTime = occurredAt || new Date().toISOString();

    // Serialize requests with the same product + metric + job ID.
    // This also protects against concurrent retries when an
    // existing unique constraint has not yet been verified.
    const lockKey = `HIRINGXCHANGE:jobs_posted:${jobId}`;

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [lockKey]
    );

    // Do not count an already-recorded job twice.
    const existing = await client.query(
      `SELECT e.id, e.period_start
         FROM usage_events e
         JOIN products p ON p.id = e.product_id
         JOIN usage_metrics m ON m.id = e.metric_id
        WHERE p.code = 'HIRINGXCHANGE'
          AND m.metric_code = 'jobs_posted'
          AND e.idempotency_key = $1
        LIMIT 1`,
      [String(jobId)]
    );

    if (existing.rowCount > 0) {
      logger.info(
  {
    operation: "record-job-posted",
    userId,
    jobId,
    duplicate: true,
  },
  "Duplicate usage event detected; skipping increment"
);
      await client.query("COMMIT");
      logger.info(
  {
    operation: "record-job-posted",
    userId,
    jobId,
    eventId: insertedEvent.id,
    duplicate: false,
  },
  "Job-posted usage recorded successfully"
);

      return {
        recorded: false,
        duplicate: true,
        eventId: existing.rows[0].id,
        periodStart: existing.rows[0].period_start
      };
    }

    
const result = await client.query(
  `INSERT INTO usage_events (
     product_id,
     metric_id,
     subscription_id,
     external_subject_id,
     external_user_id,
     idempotency_key,
     quantity,
     occurred_at,
     period_start,
     period_end,
     metadata
   )
   SELECT
     p.id,
     m.id,
     s.id,
     $1::text,  -- external_subject_id
     $1::text,
     $2::text,
     1,
     $3::timestamptz,
     date_trunc(
       'month',
       $3::timestamptz AT TIME ZONE 'UTC'
     ) AT TIME ZONE 'UTC',  -- period_start
     (
       date_trunc(
         'month',
         $3::timestamptz AT TIME ZONE 'UTC'
       ) + INTERVAL '1 month'
     ) AT TIME ZONE 'UTC',  -- period_end
     jsonb_build_object('jobId', $2::text)
   FROM products p
   JOIN usage_metrics m
     ON m.product_id = p.id
    AND m.metric_code = 'jobs_posted'
    AND m.is_active = TRUE
   JOIN LATERAL (
     SELECT sub.id
     FROM subscriptions sub
     WHERE sub.product_id = p.id
       AND sub.external_user_id = $1::text
       AND sub.status = 'active'
       AND sub.starts_at <= $3::timestamptz
       AND sub.expires_at > $3::timestamptz
     ORDER BY sub.starts_at DESC
     LIMIT 1
   ) s ON TRUE
   WHERE UPPER(p.code) = 'HIRINGXCHANGE'
   RETURNING id, subscription_id, metric_id, quantity, occurred_at, period_start,period_end`,
  [String(userId), String(jobId), eventTime]
);

const insertedEvent = result.rows[0];

if (!insertedEvent) {
  throw new Error(
    "Usage event was not inserted; cannot update usage_count"
  );
}

await client.query(
  `INSERT INTO usage_counters (
      subscription_id,
      metric_id,
      period_start,
      period_end,
      consumed_quantity,
      reserved_quantity,
      updated_at
   )
   VALUES (
      $1::uuid,
      $2::bigint,
      $3::timestamptz,
      $4::timestamptz,
      $5::bigint,
      0,
      NOW()
   )
   ON CONFLICT (
      subscription_id,
      metric_id,
      period_start,
      period_end
   )
   DO UPDATE SET
      consumed_quantity =
          usage_counters.consumed_quantity + EXCLUDED.consumed_quantity,
      updated_at = NOW()`,
  [
    insertedEvent.subscription_id,
    insertedEvent.metric_id,
    insertedEvent.period_start,
    insertedEvent.period_end,
    insertedEvent.quantity
  ]
);

    if (result.rowCount !== 1) {
      throw new Error(
        "HiringXChange jobs_posted metric is not configured"
      );
    }

    await client.query("COMMIT");

    return {
      recorded: true,
      duplicate: false,
      ...result.rows[0]
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


async function consumeUsage({
  productId,
  userId,
  metricKey,
  quantity = 1,
  idempotencyKey
}) {
  if (!productId || !userId || !metricKey || !idempotencyKey) {
    throw new Error(
      "productId, userId, metricKey, and idempotencyKey are required"
    );
  }

  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error("quantity must be a positive number");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize usage consumption for this product, user, and metric.
    const lockKey = `${productId}:${userId}:${metricKey}`;

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [lockKey]
    );

    // Find an existing event so retries do not consume usage twice.
    const existing = await client.query(
      `SELECT e.id, e.quantity, e.period_start, e.period_end,
              e.subscription_id, e.metric_id
         FROM usage_events e
        WHERE e.product_id = $1
          AND e.external_user_id = $2::text
          AND e.idempotency_key = $3::text
        LIMIT 1`,
      [productId, String(userId), String(idempotencyKey)]
    );

    if (existing.rowCount > 0) {
      const event = existing.rows[0];

      // Reject reusing the same key for a different metric or quantity.
      const original = await client.query(
        `SELECT m.metric_code
           FROM usage_metrics m
          WHERE m.id = $1`,
        [event.metric_id]
      );

      if (
        original.rows[0]?.metric_code !== metricKey ||
        Number(event.quantity) !== quantity
      ) {
        await client.query("ROLLBACK");

        const error = new Error(
          "Idempotency-Key was already used with a different request"
        );
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }

      await client.query("COMMIT");

      return {
        allowed: true,
        duplicate: true,
        metricKey,
        quantity: Number(event.quantity),
        eventId: event.id,
        periodStart: event.period_start,
        periodEnd: event.period_end
      };
    }

    const eventTime = new Date();

    // Find the active subscription and configured metric for this product.
    const config = await client.query(
      `SELECT
          p.id AS product_id,
          m.id AS metric_id,
          m.metric_code,
          s.id AS subscription_id,
          date_trunc('month', NOW() AT TIME ZONE 'UTC')
            AT TIME ZONE 'UTC' AS period_start,
          (date_trunc('month', NOW() AT TIME ZONE 'UTC')
            + INTERVAL '1 month') AT TIME ZONE 'UTC' AS period_end
       FROM products p
       JOIN usage_metrics m
         ON m.product_id = p.id
        AND m.metric_code = $3
        AND m.is_active = TRUE
       JOIN LATERAL (
         SELECT sub.id
           FROM subscriptions sub
          WHERE sub.product_id = p.id
            AND sub.external_user_id = $2::text
            AND sub.status = 'active'
            AND sub.starts_at <= NOW()
            AND sub.expires_at > NOW()
          ORDER BY sub.starts_at DESC
          LIMIT 1
       ) s ON TRUE
       WHERE p.id = $1`,
      [productId, String(userId), metricKey]
    );

    if (config.rowCount === 0) {
      await client.query("ROLLBACK");

      const error = new Error(
        "No active subscription or configured metric found"
      );
      error.code = "SUBSCRIPTION_NOT_ACTIVE";
      throw error;
    }

    const {
      product_id,
      metric_id,
      subscription_id,
      period_start,
      period_end
    } = config.rows[0];

    // Lock and read the current counter for this subscription/metric/period.
    const counter = await client.query(
      `SELECT consumed_quantity, reserved_quantity
         FROM usage_counters
        WHERE subscription_id = $1::uuid
          AND metric_id = $2::bigint
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
        FOR UPDATE`,
      [subscription_id, metric_id, period_start, period_end]
    );

    const used = counter.rowCount
      ? Number(counter.rows[0].consumed_quantity) +
        Number(counter.rows[0].reserved_quantity)
      : 0;

    // IMPORTANT: Replace this query if limits are stored on plan/plan_prices.
   const limitResult = await client.query(
  `SELECT pul.limit_value, pul.period_type
     FROM plan_usage_limits pul
    WHERE pul.product_id = $1
      AND pul.plan_id = (
        SELECT plan_id
          FROM subscriptions
         WHERE id = $2
      )
      AND pul.metric_id = $3
      AND pul.is_active = TRUE`,
  [productId, subscription_id, metric_id]
);

const limit = limitResult.rows[0]?.limit_value;
const periodType = limitResult.rows[0]?.period_type;

if (limit == null) {
  throw new Error(
    "Usage limit is not configured for this subscription plan and metric"
  );
}

    if (limit == null) {
      await client.query("ROLLBACK");

      throw new Error(
        "Usage limit is not configured for this metric"
      );
    }

    if (Number(limit) >= 0 && used + quantity > Number(limit)) {
      await client.query("ROLLBACK");

      return {
        allowed: false,
        duplicate: false,
        metricKey,
        used,
        limit: Number(limit),
        remaining: Math.max(0, Number(limit) - used),
        message: "Usage limit exceeded"
      };
    }

    // Record the usage event.
    const inserted = await client.query(
      `INSERT INTO usage_events (
          product_id,
          metric_id,
          subscription_id,
          external_subject_id,
          external_user_id,
          idempotency_key,
          quantity,
          occurred_at,
          period_start,
          period_end,
          metadata
       )
       VALUES (
          $1, $2, $3::uuid, $4::text, $4::text, $5::text,
          $6, $7, $8, $9,
          jsonb_build_object('metricKey', $10::text)
       )
       RETURNING id`,
      [
        product_id,
        metric_id,
        subscription_id,
        String(userId),
        String(idempotencyKey),
        quantity,
        eventTime,
        period_start,
        period_end,
        metricKey
      ]
    );

    // Increment the counter in the same transaction.
    await client.query(
      `INSERT INTO usage_counters (
          subscription_id,
          metric_id,
          period_start,
          period_end,
          consumed_quantity,
          reserved_quantity,
          updated_at
       )
       VALUES ($1::uuid, $2::bigint, $3, $4, $5, 0, NOW())
       ON CONFLICT (
          subscription_id, metric_id, period_start, period_end
       )
       DO UPDATE SET
          consumed_quantity =
            usage_counters.consumed_quantity + EXCLUDED.consumed_quantity,
          updated_at = NOW()`,
      [
        subscription_id,
        metric_id,
        period_start,
        period_end,
        quantity
      ]
    );

    await client.query("COMMIT");

    return {
      allowed: true,
      duplicate: false,
      metricKey,
      quantity,
      used: used + quantity,
      limit: Number(limit),
      remaining: Math.max(0, Number(limit) - used - quantity),
      eventId: inserted.rows[0].id,
      periodStart: period_start,
      periodEnd: period_end
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back.
    }

    throw error;
  } finally {
    client.release();
  }
}




export { recordJobPosted, consumeUsage };

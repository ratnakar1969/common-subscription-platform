
import pool from "../../config/database.js";
import logger from "../../config/logger.js";

function validateQuantity(quantity) {
  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error("quantity must be a positive number");
  }
}

function getEventTime(value) {
  const date = value == null ? new Date() : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("occurredAt must be a valid timestamp");
  }

  return date;
}

function getUtcMonth(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1))
  };
}

async function recordUsage({
  productId,
  productCode,
  userId,
  metricKey,
  quantity = 1,
  idempotencyKey,
  occurredAt,
  metadata = {}
}) {
  if ((!productId && !productCode) || !userId ||
      !metricKey || !idempotencyKey) {
    throw new Error(
      "product, userId, metricKey and idempotencyKey are required"
    );
  }

  validateQuantity(quantity);

  const eventTime = getEventTime(occurredAt);
  const { start: periodStart, end: periodEnd } =
    getUtcMonth(eventTime);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `SELECT id, code
         FROM products
        WHERE ${productId ? "id = $1" : "UPPER(code) = UPPER($1)"}
          AND is_active = TRUE`,
      [productId || productCode]
    );

    if (!productResult.rowCount) {
      const error = new Error("Product is not configured or inactive");
      error.code = "PRODUCT_NOT_CONFIGURED";
      throw error;
    }

    const product = productResult.rows[0];

    const metricResult = await client.query(
      `SELECT id
         FROM usage_metrics
        WHERE product_id = $1
          AND metric_code = $2
          AND is_active = TRUE`,
      [product.id, metricKey]
    );

    if (!metricResult.rowCount) {
      const error = new Error(
        `Usage metric '${metricKey}' is not configured`
      );
      error.code = "METRIC_NOT_CONFIGURED";
      throw error;
    }

    const metricId = metricResult.rows[0].id;

    // Serialize retries using the idempotency key, including attempts
    // that reuse a key with a different metric.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`usage-key:${product.id}:${userId}:${idempotencyKey}`]
    );

    // Serialize quota consumption for this product/user/metric.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`usage-quota:${product.id}:${userId}:${metricId}`]
    );

    const existing = await client.query(
      `SELECT e.id, e.quantity, e.period_start, e.period_end,
              e.subscription_id, e.metric_id
         FROM usage_events e
        WHERE e.product_id = $1
          AND e.external_user_id = $2::text
          AND e.idempotency_key = $3::text
        LIMIT 1`,
      [product.id, String(userId), String(idempotencyKey)]
    );

    if (existing.rowCount) {
      const event = existing.rows[0];

      if (
        String(event.metric_id) !== String(metricId) ||
        Number(event.quantity) !== quantity
      ) {
        const error = new Error(
          "Idempotency-Key was already used with a different request"
        );
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }

      await client.query("COMMIT");

      return {
        allowed: true,
        recorded: false,
        duplicate: true,
        metricKey,
        quantity: Number(event.quantity),
        eventId: event.id,
        periodStart: event.period_start,
        periodEnd: event.period_end
      };
    }

    // Select the subscription that was active at the event timestamp.
    const subscriptionResult = await client.query(
      `SELECT s.id, s.plan_id
         FROM subscriptions s
        WHERE s.product_id = $1
          AND s.external_user_id = $2::text
          AND s.status = 'active'
          AND s.starts_at <= $3::timestamptz
          AND s.expires_at > $3::timestamptz
        ORDER BY s.starts_at DESC
        LIMIT 1
        FOR UPDATE`,
      [product.id, String(userId), eventTime]
    );

    if (!subscriptionResult.rowCount) {
      const error = new Error(
        "No active subscription found for this user and event time"
      );
      error.code = "SUBSCRIPTION_NOT_ACTIVE";
      throw error;
    }

    const subscription = subscriptionResult.rows[0];

    // plan_usage_limits is the authoritative limit source.
    const limitResult = await client.query(
      `SELECT pul.limit_value, pul.period_type
         FROM plan_usage_limits pul
        WHERE pul.product_id = $1
          AND pul.plan_id = $2
          AND pul.metric_id = $3
          AND pul.is_active = TRUE`,
      [product.id, subscription.plan_id, metricId]
    );

    if (!limitResult.rowCount) {
      const error = new Error(
        "Usage limit is not configured for this plan and metric"
      );
      error.code = "USAGE_LIMIT_NOT_CONFIGURED";
      throw error;
    }

    const limitRow = limitResult.rows[0];
    const limit = Number(limitRow.limit_value);

    if (!Number.isFinite(limit)) {
      throw new Error("Configured usage limit is invalid");
    }

    // This implementation deliberately uses UTC calendar months.
    // Reject incompatible limit periods rather than silently applying
    // monthly accounting to a differently configured limit.
    if (
      limitRow.period_type &&
      !["month", "monthly", "calendar_month"].includes(
        String(limitRow.period_type).toLowerCase()
      )
    ) {
      const error = new Error(
        `Unsupported usage limit period: ${limitRow.period_type}`
      );
      error.code = "USAGE_PERIOD_NOT_SUPPORTED";
      throw error;
    }

    const counterResult = await client.query(
      `SELECT consumed_quantity, reserved_quantity
         FROM usage_counters
        WHERE subscription_id = $1::uuid
          AND metric_id = $2::bigint
          AND period_start = $3::timestamptz
          AND period_end = $4::timestamptz
        FOR UPDATE`,
      [
        subscription.id,
        metricId,
        periodStart,
        periodEnd
      ]
    );

    const used = counterResult.rowCount
      ? Number(counterResult.rows[0].consumed_quantity) +
        Number(counterResult.rows[0].reserved_quantity)
      : 0;

    // A negative limit means unlimited, matching the existing convention.
    if (limit >= 0 && used + quantity > limit) {
      await client.query("ROLLBACK");

      return {
        allowed: false,
        recorded: false,
        duplicate: false,
        metricKey,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        periodStart,
        periodEnd,
        message: "Usage limit exceeded"
      };
    }

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
          $6, $7::timestamptz, $8::timestamptz,
          $9::timestamptz, $10::jsonb
       )
       RETURNING id, subscription_id, metric_id, quantity,
                 occurred_at, period_start, period_end`,
      [
        product.id,
        metricId,
        subscription.id,
        String(userId),
        String(idempotencyKey),
        quantity,
        eventTime,
        periodStart,
        periodEnd,
        JSON.stringify({ ...metadata, metricKey })
      ]
    );

    const event = inserted.rows[0];

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
        subscription.id,
        metricId,
        periodStart,
        periodEnd,
        quantity
      ]
    );

    await client.query("COMMIT");

    logger.info(
      {
        operation: "usage-recorded",
        productCode: product.code,
        userId,
        metricKey,
        quantity,
        eventId: event.id,
        used: used + quantity,
        limit
      },
      "Usage recorded successfully"
    );

    return {
      allowed: true,
      recorded: true,
      duplicate: false,
      metricKey,
      quantity,
      used: used + quantity,
      limit,
      remaining: limit < 0 ? null : Math.max(0, limit - used - quantity),
      ...event
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error if rollback is no longer possible.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function recordJobPosted({ userId, jobId, occurredAt }) {
  if (!userId || !jobId) {
    throw new Error("userId and jobId are required");
  }

  const result = await recordUsage({
    productCode: "HIRINGXCHANGE",
    userId,
    metricKey: "jobs_posted",
    quantity: 1,
    idempotencyKey: String(jobId),
    occurredAt,
    metadata: { jobId: String(jobId) }
  });

  return result;
}

async function consumeUsage({
  productId,
  userId,
  metricKey,
  quantity = 1,
  idempotencyKey
}) {
  return recordUsage({
    productId,
    userId,
    metricKey,
    quantity,
    idempotencyKey
  });
}

export { recordJobPosted, consumeUsage };

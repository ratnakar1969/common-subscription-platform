
import express from "express";
import {
  recordJobPosted,
  consumeUsage
} from "./usageService.js";
import authProduct from "../../middleware/authProduct.js";
import logger from "../../config/logger.js";

const router = express.Router();

function sendUsageError(res, error, operation) {
  logger.error(
    {
      operation,
      errorCode: error.code,
      message: error.message
    },
    "Usage operation failed"
  );

  const responses = {
    PRODUCT_NOT_CONFIGURED: [404, error.message],
    METRIC_NOT_CONFIGURED: [404, error.message],
    USAGE_LIMIT_NOT_CONFIGURED: [500, error.message],
    USAGE_PERIOD_NOT_SUPPORTED: [500, error.message],
    SUBSCRIPTION_NOT_ACTIVE: [403, error.message],
    IDEMPOTENCY_CONFLICT: [409, error.message]
  };

  const [status, message] = responses[error.code] ||
    (error.message.includes("must be") ||
     error.message.includes("required") ||
     error.message.includes("valid timestamp")
      ? [400, error.message]
      : [500, "Unable to process usage"]);

  return res.status(status).json({
    success: false,
    message,
    ...(error.code ? { code: error.code } : {})
  });
}

function sendUsageResult(res, result) {
  if (result.allowed === false) {
    return res.status(409).json({
      success: false,
      ...result
    });
  }

  return res.status(200).json({
    success: true,
    ...result
  });
}

// Backward-compatible HiringXChange endpoint.
router.post("/record-job-posted", authProduct, async (req, res) => {
  try {
    const { userId, jobId, occurredAt } = req.body || {};

    if (!userId || !jobId) {
      return res.status(400).json({
        success: false,
        message: "userId and jobId are required"
      });
    }

    if (
      req.product?.code &&
      req.product.code.toUpperCase() !== "HIRINGXCHANGE"
    ) {
      return res.status(403).json({
        success: false,
        message: "This endpoint is only for HiringXChange"
      });
    }

    const result = await recordJobPosted({
      userId,
      jobId,
      occurredAt
    });

    return sendUsageResult(res, {
      metric: "jobs_posted",
      ...result
    });
  } catch (error) {
    return sendUsageError(res, error, "record-job-posted");
  }
});

// Generic usage API for all registered products and metrics.
router.post("/consume", authProduct, async (req, res) => {
  try {
    const { userId, metricKey, quantity = 1 } = req.body || {};
    const idempotencyKey = req.get("Idempotency-Key");

    if (!userId || !metricKey || !idempotencyKey) {
      return res.status(400).json({
        success: false,
        message:
          "userId, metricKey and Idempotency-Key header are required"
      });
    }

    if (
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "quantity must be a positive number"
      });
    }

    const result = await consumeUsage({
      productId: req.product.id,
      userId,
      metricKey,
      quantity,
      idempotencyKey
    });

    return sendUsageResult(res, result);
  } catch (error) {
    return sendUsageError(res, error, "consume-usage");
  }
});

export default router;

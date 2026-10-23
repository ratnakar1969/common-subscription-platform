
import express from "express";
import {
  recordJobPosted,
  consumeUsage
} from "./usageService.js";
import authProduct from "../../middleware/authProduct.js";

const router = express.Router();

// Existing endpoint — keep backward compatibility.
router.post("/record-job-posted", authProduct, async (req, res) => {
  try {
    const { userId, jobId, occurredAt } = req.body;

    if (!userId || !jobId) {
      return res.status(400).json({
        success: false,
        message: "userId and jobId are required"
      });
    }

    const result = await recordJobPosted({
      userId,
      jobId,
      occurredAt
    });

    return res.status(200).json({
      success: true,
      metric: "jobs_posted",
      ...result
    });
  } catch (error) {
    console.error("Usage recording failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to record job usage"
    });
  }
});

// Generic endpoint for all products and usage metrics.
router.post("/consume", authProduct, async (req, res) => {
  try {
    const { userId, metricKey, quantity = 1 } = req.body;
    const idempotencyKey = req.get("Idempotency-Key");

    if (!userId || !metricKey || !idempotencyKey) {
      return res.status(400).json({
        success: false,
        message:
          "userId, metricKey, and Idempotency-Key header are required"
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
  } catch (error) {
    console.error("Usage consumption failed:", error);

    if (error.code === "METRIC_NOT_CONFIGURED") {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }

    if (error.code === "SUBSCRIPTION_NOT_ACTIVE") {
      return res.status(403).json({
        success: false,
        message: error.message
      });
    }

    if (error.code === "IDEMPOTENCY_CONFLICT") {
  return res.status(409).json({
    success: false,
    message: error.message
  });
}

    return res.status(500).json({
      success: false,
      message: "Unable to consume usage"
    });
  }
});

export default router;

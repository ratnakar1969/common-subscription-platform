
import { Router } from "express";
import crypto from "node:crypto";
import pool from "../../config/database.js";
import razorpay from "../../config/razorPay.js";
import authenticateProduct from "../../middleware/authProduct.js";

const router = Router();

router.post("/verify", authenticateProduct, async (req, res) => {
  const {
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  } = req.body ?? {};

  if (
    typeof orderId !== "string" ||
    typeof razorpayOrderId !== "string" ||
    typeof razorpayPaymentId !== "string" ||
    typeof razorpaySignature !== "string" ||
    !orderId.trim() ||
    !razorpayOrderId.trim() ||
    !razorpayPaymentId.trim() ||
    !/^[a-fA-F0-9]{64}$/.test(razorpaySignature)
  ) {
    return res.status(400).json({
      error: "Invalid payment verification request",
    });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;

  if (!secret) {
    console.error("RAZORPAY_KEY_SECRET is not configured");

    return res.status(500).json({
      error: "Payment verification is not configured",
    });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // 1. Find and lock the order belonging to this product.
    const orderResult = await client.query(
      `SELECT id, product_id, external_user_id, plan_id,
              amount_paise, currency, status,
              razorpay_order_id, razorpay_payment_id
       FROM orders
       WHERE id = $1 AND product_id = $2
       FOR UPDATE`,
      [orderId, req.product.id]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = orderResult.rows[0];

    if (order.razorpay_order_id !== razorpayOrderId) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "Razorpay order does not match the internal order",
      });
    }

    // Accept pending orders and previously paid orders being retried.
    if (!["payment_pending", "paid"].includes(order.status)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: `Order cannot be verified from status: ${order.status}`,
      });
    }

    // 2. Verify Razorpay Checkout's HMAC signature.
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest();

    const receivedSignature = Buffer.from(
      razorpaySignature,
      "hex"
    );

    if (
      expectedSignature.length !== receivedSignature.length ||
      !crypto.timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "Invalid Razorpay payment signature",
      });
    }

    // 3. Independently fetch the payment from Razorpay.
    const payment = await razorpay.payments.fetch(razorpayPaymentId);

    if (
      payment.order_id !== order.razorpay_order_id ||
      Number(payment.amount) !== Number(order.amount_paise) ||
      payment.currency !== order.currency.trim()
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "Payment details do not match the order",
      });
    }

    if (payment.status !== "captured") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: "Payment is not captured yet",
        paymentStatus: payment.status,
      });
    }

    if (
      order.razorpay_payment_id &&
      order.razorpay_payment_id !== payment.id
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: "A different payment is already associated with this order",
      });
    }

    // 4. Load the plan associated with this order and product.
    // Do not require is_active here: a plan may have been deactivated
    // after the customer legitimately placed the order.
    const planResult = await client.query(
      `SELECT id, duration_days
       FROM plans
       WHERE id = $1 AND product_id = $2`,
      [order.plan_id, order.product_id]
    );

    if (
      planResult.rowCount === 0 ||
      !Number.isInteger(planResult.rows[0]?.duration_days) ||
      planResult.rows[0].duration_days <= 0
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: "The order's subscription plan or duration is invalid",
      });
    }

    const plan = planResult.rows[0];

    // 5. Persist the verified payment idempotently.
    const existingPaymentResult = await client.query(
      `SELECT id, razorpay_payment_id
       FROM payments
       WHERE order_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [order.id]
    );

    if (existingPaymentResult.rowCount > 0) {
      const existingPayment = existingPaymentResult.rows[0];

      if (
        existingPayment.razorpay_payment_id &&
        existingPayment.razorpay_payment_id !== payment.id
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          error: "A different payment is already recorded for this order",
        });
      }

      await client.query(
        `UPDATE payments
         SET razorpay_payment_id = $2,
             amount_paise = $3,
             currency = $4,
             status = $5,
             method = $6,
             raw_details = $7::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existingPayment.id,
          payment.id,
          Number(payment.amount),
          payment.currency,
          payment.status,
          payment.method ?? null,
          JSON.stringify(payment),
        ]
      );
    } else {
      await client.query(
        `INSERT INTO payments (
           id, order_id, razorpay_payment_id,
           amount_paise, currency, status,
           method, raw_details, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1, $2, $3, $4,
           $5, $6, $7::jsonb, NOW(), NOW()
         )`,
        [
          order.id,
          payment.id,
          Number(payment.amount),
          payment.currency,
          payment.status,
          payment.method ?? null,
          JSON.stringify(payment),
        ]
      );
    }

    // 6. Mark the order paid and retain the verified signature.
    await client.query(
      `UPDATE orders
       SET status = 'paid',
           razorpay_payment_id = $2,
           payment_signature = $3,
           paid_at = COALESCE(paid_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, payment.id, razorpaySignature]
    );

    // 7. Activate a subscription for this specific order.
    // Do not create a duplicate subscription when verification is retried.
    const existingSubscriptionResult = await client.query(
      `SELECT id, status, starts_at, expires_at
       FROM subscriptions
       WHERE order_id = $1
       LIMIT 1
       FOR UPDATE`,
      [order.id]
    );

    let subscription = existingSubscriptionResult.rows[0];

    if (!subscription) {
      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions (
           id,
           product_id,
           external_user_id,
           plan_id,
           order_id,
           status,
           starts_at,
           expires_at,
           created_at
         )
         VALUES (
           gen_random_uuid(),
           $1, $2, $3, $4,
           'active',
           NOW(),
           NOW() + ($5 * INTERVAL '1 day'),
           NOW()
         )
         RETURNING id, status, starts_at, expires_at`,
        [
          order.product_id,
          order.external_user_id,
          order.plan_id,
          order.id,
          plan.duration_days,
        ]
      );

      subscription = subscriptionResult.rows[0];
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      orderId: order.id,
      razorpayOrderId: order.razorpay_order_id,
      razorpayPaymentId: payment.id,
      orderStatus: "paid",
      paymentStatus: "captured",
      subscription: {
        id: subscription.id,
        status: subscription.status,
        startsAt: subscription.starts_at,
        expiresAt: subscription.expires_at,
      },
      message: "Payment verified and subscription processed successfully",
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Payment verification failed:", error.message);

    return res.status(502).json({
      error: "Unable to verify payment. Please retry safely.",
    });
  } finally {
    client.release();
  }
});

export default router;

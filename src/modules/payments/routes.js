
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

  try {
    await client.query("BEGIN");

    // Scope the internal order to the authenticated product.
    const orderResult = await client.query(
      `SELECT id, product_id, amount_paise, currency,
              status, razorpay_order_id
       FROM orders
       WHERE id = $1 AND product_id = $2
       FOR UPDATE`,
      [orderId, req.product.id]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Order not found",
      });
    }

    const order = orderResult.rows[0];

    // Never trust the Razorpay order ID supplied by the client alone.
    if (order.razorpay_order_id !== razorpayOrderId) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Razorpay order does not match the internal order",
      });
    }

    // Idempotent response for a previously verified payment.
    if (order.status === "paid") {
      await client.query("COMMIT");

      return res.status(200).json({
        orderId: order.id,
        status: "paid",
        message: "Payment already verified",
      });
    }

    if (order.status !== "payment_pending") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: `Order cannot be verified from status: ${order.status}`,
      });
    }

    // Razorpay Checkout signature:
    // HMAC-SHA256(razorpayOrderId + "|" + paymentId, keySecret)
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

      return res.status(400).json({
        error: "Invalid Razorpay payment signature",
      });
    }

    // Independently confirm the payment with Razorpay.
    const payment = await razorpay.payments.fetch(razorpayPaymentId);

    if (
      payment.order_id !== order.razorpay_order_id ||
      Number(payment.amount) !== Number(order.amount_paise) ||
      payment.currency !== order.currency
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Payment details do not match the order",
      });
    }

    if (payment.status !== "captured") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "Payment is not captured yet",
        paymentStatus: payment.status,
      });
    }

    // Mark the order paid only after verification.
    // Subscription activation and payment persistence
    // must be added to this transaction.
   
    // Persist the verified Razorpay payment.
    // This runs inside the same transaction as the order update.
    await client.query(
      `INSERT INTO payments (
         id,
         order_id,
         razorpay_payment_id,
         amount_paise,
         currency,
         status,
         method,
         raw_details,
         created_at,
         updated_at
       )
       VALUES (
         gen_random_uuid(),
         $1, $2, $3, $4, $5, $6, $7::jsonb,
         NOW(), NOW()
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

    // Mark the order paid only after verification and payment persistence.
    await client.query(
      `UPDATE orders
       SET status = 'paid',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'payment_pending'`,
      [order.id]
    );



    await client.query("COMMIT");

    return res.status(200).json({
      orderId: order.id,
      razorpayOrderId: order.razorpay_order_id,
      razorpayPaymentId: payment.id,
      status: "paid",
      message: "Payment verified successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Payment verification failed:", error.message);

    return res.status(502).json({
      error: "Unable to verify payment. Please retry safely.",
    });
  } finally {
    client.release();
  }
});

export default router;

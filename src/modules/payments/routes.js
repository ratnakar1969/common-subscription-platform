
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pool from '../../config/database.js';
import razorpay from '../../config/razorPay.js';
import authenticateProduct from '../../middleware/authProduct.js';

const router = Router();

function verifySignature(orderId, paymentId, signature) {
  if (
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return false;
  }

  const expected = createHmac(
    'sha256',
    process.env.RAZORPAY_KEY_SECRET
  )
    .update(`${orderId}|${paymentId}`)
    .digest();

  const received = Buffer.from(signature, 'hex');

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

router.post('/verify', authenticateProduct, async (req, res) => {
  const {
    orderId,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  } = req.body ?? {};

  if (
    typeof orderId !== 'string' ||
    typeof razorpayOrderId !== 'string' ||
    typeof razorpayPaymentId !== 'string' ||
    typeof razorpaySignature !== 'string'
  ) {
    return res.status(400).json({
      error: 'Missing or invalid payment verification fields',
    });
  }

  let client;
  let transactionStarted = false;

  try {
    // Find the order belonging to the authenticated product.
    const orderResult = await pool.query(
      `SELECT id, product_id, external_user_id, plan_id,
              amount_paise, currency, status,
              razorpay_order_id, razorpay_payment_id
       FROM orders
       WHERE id = $1 AND product_id = $2`,
      [orderId, req.product.id]
    );

    if (orderResult.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.razorpay_order_id !== razorpayOrderId) {
      return res.status(400).json({
        error: 'Razorpay order ID does not match the stored order',
      });
    }

    if (
      !verifySignature(
        order.razorpay_order_id,
        razorpayPaymentId,
        razorpaySignature
      )
    ) {
      return res.status(400).json({
        error: 'Invalid Razorpay payment signature',
      });
    }

    // Verify the payment directly with Razorpay.
    const payment = await razorpay.payments.fetch(razorpayPaymentId);

    if (
      payment.order_id !== order.razorpay_order_id ||
      Number(payment.amount) !== Number(order.amount_paise) ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        error: 'Payment details do not match the stored order',
      });
    }

    if (payment.status !== 'captured') {
      return res.status(409).json({
        error: 'Payment is not captured yet',
        paymentStatus: payment.status,
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // Lock the order so simultaneous retries cannot activate it twice.
    const lockedResult = await client.query(
      `SELECT id, product_id, external_user_id, plan_id,
              amount_paise, currency, status,
              razorpay_payment_id
       FROM orders
       WHERE id = $1 AND product_id = $2
       FOR UPDATE`,
      [orderId, req.product.id]
    );

    if (lockedResult.rowCount === 0) {
      throw new Error('Order not found during payment processing');
    }

    const lockedOrder = lockedResult.rows[0];

    if (
      lockedOrder.status === 'paid' &&
      lockedOrder.razorpay_payment_id &&
      lockedOrder.razorpay_payment_id !== razorpayPaymentId
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(409).json({
        error: 'Order has already been paid with a different payment',
      });
    }

    if (
      !['payment_pending', 'paid'].includes(lockedOrder.status)
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(409).json({
        error: 'Order is not awaiting payment',
        orderStatus: lockedOrder.status,
      });
    }

    // Load the subscription duration from the database.
    const planResult = await client.query(
      `SELECT duration_days
       FROM plans
       WHERE id = $1 AND product_id = $2`,
      [lockedOrder.plan_id, lockedOrder.product_id]
    );

    if (planResult.rowCount === 0) {
      throw new Error('Plan not found for this order');
    }

    const durationDays = Number(planResult.rows[0].duration_days);

    if (!Number.isInteger(durationDays) || durationDays <= 0) {
      throw new Error('Invalid subscription plan duration');
    }

    // Record the payment unless this payment is already recorded.
    const existingPayment = await client.query(
      `SELECT order_id, razorpay_payment_id
       FROM payments
       WHERE order_id = $1 OR razorpay_payment_id = $2
       FOR UPDATE`,
      [orderId, razorpayPaymentId]
    );

    if (existingPayment.rows.length > 0) {
      const matches = existingPayment.rows.every(
        (row) =>
          row.order_id === orderId &&
          row.razorpay_payment_id === razorpayPaymentId
      );

      if (!matches) {
        throw new Error(
          'Payment record conflicts with another order or payment'
        );
      }
    } else {
      await client.query(
        `INSERT INTO payments (
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
         VALUES ($1, $2, $3, $4, 'captured', $5, $6::jsonb, NOW(), NOW())`,
        [
          orderId,
          razorpayPaymentId,
          payment.amount,
          payment.currency,
          payment.method ?? null,
          JSON.stringify(payment),
        ]
      );
    }

    // Mark the order paid. This also repairs an order previously
    // marked paid by the older route without a payment record.
    await client.query(
      `UPDATE orders
       SET razorpay_payment_id = $1,
           payment_signature = $2,
           paid_at = COALESCE(paid_at, NOW()),
           status = 'paid',
           updated_at = NOW()
       WHERE id = $3`,
      [razorpayPaymentId, razorpaySignature, orderId]
    );

    // Don't create a second subscription when verification is retried.
    let subscriptionResult = await client.query(
      `SELECT id, starts_at, expires_at, status
       FROM subscriptions
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );

    if (subscriptionResult.rowCount === 0) {
      // Extend from the later of now or the user's current active expiry.
      subscriptionResult = await client.query(
        `WITH next_start AS (
           SELECT GREATEST(
             NOW(),
             COALESCE(MAX(expires_at), NOW())
           ) AS starts_at
           FROM subscriptions
           WHERE product_id = $1
             AND external_user_id = $2
             AND status = 'active'
             AND expires_at > NOW()
         )
         INSERT INTO subscriptions (
           product_id,
           external_user_id,
           plan_id,
           order_id,
           status,
           starts_at,
           expires_at,
           created_at
         )
         SELECT
           $1,
           $2,
           $3,
           $4,
           'active',
           next_start.starts_at,
           next_start.starts_at + ($5 * INTERVAL '1 day'),
           NOW()
         FROM next_start
         WHERE NOT EXISTS (
           SELECT 1 FROM subscriptions WHERE order_id = $4
         )
         RETURNING id, starts_at, expires_at, status`,
        [
          lockedOrder.product_id,
          lockedOrder.external_user_id,
          lockedOrder.plan_id,
          orderId,
          durationDays,
        ]
      );

      // A concurrent or previous activation may already have inserted it.
      if (subscriptionResult.rowCount === 0) {
        subscriptionResult = await client.query(
          `SELECT id, starts_at, expires_at, status
           FROM subscriptions
           WHERE order_id = $1
           LIMIT 1`,
          [orderId]
        );
      }
    }

    if (subscriptionResult.rowCount === 0) {
      throw new Error('Subscription activation did not create a record');
    }

    await client.query('COMMIT');
    transactionStarted = false;

    const subscription = subscriptionResult.rows[0];

    return res.status(200).json({
      message: 'Payment verified successfully',
      orderId,
      razorpayPaymentId,
      paymentStatus: 'captured',
      orderStatus: 'paid',
      subscriptionActivated: subscription.status === 'active',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        startsAt: subscription.starts_at,
        expiresAt: subscription.expires_at,
      },
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Payment verification failed:', error);

    return res.status(500).json({
      error: 'Unable to complete payment verification and activation',
    });
  } finally {
    client?.release();
  }
});

export default router;

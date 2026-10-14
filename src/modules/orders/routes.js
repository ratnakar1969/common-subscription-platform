
import { Router } from 'express';
import pool from '../../config/database.js';
import razorpay from '../../config/razorPay.js';
import authenticateProduct from '../../middleware/authProduct.js';

const router = Router();

router.post('/', authenticateProduct, async (req, res) => {
  const { planCode, externalUserId } = req.body ?? {};
  const idempotencyKey = req.get('Idempotency-Key');

  if (
    typeof planCode !== 'string' ||
    !/^[A-Za-z0-9_-]{1,50}$/.test(planCode) ||
    typeof externalUserId !== 'string' ||
    externalUserId.trim().length === 0 ||
    externalUserId.length > 150 ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.length > 150
  ) {
    return res.status(400).json({
      error:
        'Provide a valid planCode, externalUserId and Idempotency-Key header',
    });
  }

  const client = await pool.connect();
  let orderId;

  try {
    await client.query('BEGIN');

    // Only select a plan belonging to the authenticated product.
    const planResult = await client.query(
      `SELECT id, code, name, price_paise, duration_days
       FROM plans
       WHERE product_id = $1
         AND code = $2
         AND is_active = TRUE`,
      [req.product.id, planCode]
    );

    if (planResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Active plan not found for this product',
      });
    }

    const plan = planResult.rows[0];
    const amountPaise = Number(plan.price_paise);

    // Free plans should be activated without creating a Razorpay order.
    if (amountPaise === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This is a free plan. Use the free-plan activation flow.',
      });
    }

    // Lock an existing order so concurrent retries cannot create
    // separate Razorpay orders for the same idempotency key.
    let existingResult = await client.query(
      `SELECT id, plan_id, amount_paise, currency, status,
              razorpay_order_id
       FROM orders
       WHERE product_id = $1
         AND external_user_id = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [req.product.id, externalUserId, idempotencyKey]
    );

    if (existingResult.rowCount > 0) {
      const existing = existingResult.rows[0];

      if (
        String(existing.plan_id) !== String(plan.id) ||
        Number(existing.amount_paise) !== amountPaise
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Idempotency key was already used for a different order',
        });
      }

      if (existing.razorpay_order_id) {
        await client.query('COMMIT');
        return res.status(200).json({
          orderId: existing.id,
          razorpayOrderId: existing.razorpay_order_id,
          amountPaise: Number(existing.amount_paise),
          currency: existing.currency,
          status: existing.status,
          keyId: process.env.RAZORPAY_KEY_ID,
        });
      }

      // A previous attempt may have failed after creating the DB row.
      if (existing.status === 'failed') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Previous order creation failed. Retry with a new Idempotency-Key.',
        });
      }

      orderId = existing.id;
    } else {
      const insertResult = await client.query(
        `INSERT INTO orders
           (product_id, external_user_id, plan_id, amount_paise,
            currency, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'INR', 'created', $5)
         ON CONFLICT (product_id, external_user_id, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [
          req.product.id,
          externalUserId,
          plan.id,
          amountPaise,
          idempotencyKey,
        ]
      );

      if (insertResult.rowCount === 0) {
        // Another request won the race to insert this idempotency key.
        existingResult = await client.query(
          `SELECT id, plan_id, amount_paise, currency, status,
                  razorpay_order_id
           FROM orders
           WHERE product_id = $1
             AND external_user_id = $2
             AND idempotency_key = $3
           FOR UPDATE`,
          [req.product.id, externalUserId, idempotencyKey]
        );

        const existing = existingResult.rows[0];

        if (
          String(existing.plan_id) !== String(plan.id) ||
          Number(existing.amount_paise) !== amountPaise
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Idempotency key was already used for a different order',
          });
        }

        if (existing.razorpay_order_id) {
          await client.query('COMMIT');
          return res.status(200).json({
            orderId: existing.id,
            razorpayOrderId: existing.razorpay_order_id,
            amountPaise: Number(existing.amount_paise),
            currency: existing.currency,
            status: existing.status,
            keyId: process.env.RAZORPAY_KEY_ID,
          });
        }

        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Order creation is already in progress. Retry shortly.',
        });
      }

      orderId = insertResult.rows[0].id;
    }

    // Amount is derived from the database, never from the request body.
    // Keep the DB transaction open to serialize concurrent retries.
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: String(orderId),
      notes: {
        productCode: req.product.code,
        planCode: plan.code,
        externalUserId,
        internalOrderId: String(orderId),
      },
    });

    await client.query(
      `UPDATE orders
       SET razorpay_order_id = $1,
           status = 'payment_pending',
           updated_at = NOW()
       WHERE id = $2`,
      [razorpayOrder.id, orderId]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      orderId,
      razorpayOrderId: razorpayOrder.id,
      amountPaise,
      currency: 'INR',
      plan: {
        code: plan.code,
        name: plan.name,
        durationDays: plan.duration_days,
      },
      status: 'payment_pending',
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    console.error('Order creation failed:', error.message);

    if (orderId) {
      await pool.query(
        `UPDATE orders
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND razorpay_order_id IS NULL
           AND status = 'created'`,
        [orderId]
      ).catch((dbError) => {
        console.error('Could not update failed order:', dbError.message);
      });
    }

    return res.status(502).json({
      error: 'Unable to create payment order. Check the order status before retrying.',
    });
  } finally {
    client.release();
  }
});

export default router;

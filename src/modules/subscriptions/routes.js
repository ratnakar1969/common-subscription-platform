
import { Router } from 'express';
import pool from '../../config/database.js';
import authenticateProduct from '../../middleware/authProduct.js';

const router = Router();

// POST /api/entitlements/check
router.post('/check', authenticateProduct, async (req, res) => {
  const { externalUserId } = req.body ?? {};

  if (
    typeof externalUserId !== 'string' ||
    externalUserId.trim().length === 0
  ) {
    return res.status(400).json({
      error: 'externalUserId is required',
    });
  }

  try {
    const subscriptionResult = await pool.query(
      `SELECT
         s.id AS subscription_id,
         s.status AS subscription_status,
         s.starts_at,
         s.expires_at,
         pl.id AS plan_id,
         pl.code AS plan_code,
         pl.name AS plan_name
       FROM subscriptions s
       JOIN plans pl
         ON pl.id = s.plan_id
        AND pl.product_id = s.product_id
       WHERE s.product_id = $1
         AND s.external_user_id = $2
         AND s.status = 'active'
         AND s.starts_at <= NOW()
         AND s.expires_at > NOW()
       ORDER BY s.expires_at DESC
       LIMIT 1`,
      [req.product.id, externalUserId.trim()]
    );

    if (subscriptionResult.rowCount === 0) {
      return res.status(200).json({
        externalUserId: externalUserId.trim(),
        hasActiveSubscription: false,
        hasPremiumAccess: false,
        plan: null,
        features: {},
        expiresAt: null,
      });
    }

    const subscription = subscriptionResult.rows[0];

    const featureResult = await pool.query(
      `SELECT
         pf.code,
         pf.name,
         pft.enabled
       FROM product_features pf
       LEFT JOIN plan_features pft
         ON pft.feature_id = pf.id
        AND pft.plan_id = $2
        AND pft.product_id = pf.product_id
       WHERE pf.product_id = $1
         AND pf.is_active = TRUE
       ORDER BY pf.code`,
      [req.product.id, subscription.plan_id]
    );

    const features = {};

    for (const feature of featureResult.rows) {
      features[feature.code] = {
        name: feature.name,
        enabled: feature.enabled === true,
      };
    }

    const hasPremiumAccess = Object.entries(features).some(
      ([code, feature]) =>
        code !== 'basic_access' && feature.enabled
    );

    return res.status(200).json({
      externalUserId: externalUserId.trim(),
      hasActiveSubscription: true,
      hasPremiumAccess,
      plan: {
        code: subscription.plan_code,
        name: subscription.plan_name,
      },
      features,
      startsAt: subscription.starts_at,
      expiresAt: subscription.expires_at,
    });
  } catch (error) {
    console.error('Entitlement check failed:', error.message);

    return res.status(500).json({
      error: 'Unable to check subscription entitlement',
    });
  }
});

export default router;

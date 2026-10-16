
import { Router } from 'express';
import pool from '../../config/database.js';
import authenticateProduct from '../../middleware/authProduct.js';

const router = Router();

router.get('/', authenticateProduct, async (req, res) => {
  try {
    const country = req.query.country
      ? String(req.query.country).trim().toUpperCase()
      : null;

    const currency = req.query.currency
      ? String(req.query.currency).trim().toUpperCase()
      : null;

    if ((country && !currency) || (!country && currency)) {
      return res.status(400).json({
        error: 'Provide both country and currency, or neither.',
      });
    }

    if (
      (country && !/^[A-Z]{2}$/.test(country)) ||
      (currency && !/^[A-Z]{3}$/.test(currency))
    ) {
      return res.status(400).json({
        error: 'Invalid country or currency code.',
      });
    }

    const result = await pool.query(
      `SELECT
          p.code,
          p.name,
          p.price_paise AS default_price_paise,
          p.duration_days,
          pp.amount_minor AS country_price_minor,
          pp.currency AS country_currency,
          pp.country_code,
          CASE
            WHEN pp.id IS NOT NULL THEN pp.amount_minor
            ELSE p.price_paise
          END AS effective_price_minor,
          CASE
            WHEN pp.id IS NOT NULL THEN pp.currency
            WHEN $3 = 'INR' OR $3 IS NULL THEN 'INR'
            ELSE NULL
          END AS effective_currency
       FROM plans p
       LEFT JOIN LATERAL (
          SELECT
              price.id,
              price.amount_minor,
              price.currency,
              price.country_code
          FROM plan_prices price
          WHERE price.plan_id = p.id
            AND price.country_code = $2
            AND price.currency = $3
            AND price.is_active = TRUE
            AND price.effective_from <= NOW()
            AND (
              price.effective_to IS NULL
              OR price.effective_to > NOW()
            )
          ORDER BY price.effective_from DESC, price.id DESC
          LIMIT 1
       ) pp ON TRUE
       WHERE p.product_id = $1
         AND p.is_active = TRUE
       ORDER BY effective_price_minor ASC`,
      [req.product.id, country, currency]
    );

    const plans = result.rows.map((plan) => {
      const amountMinor = Number(plan.effective_price_minor);
      const effectiveCurrency = plan.effective_currency;

      return {
        code: plan.code,
        name: plan.name,
        priceMinor: amountMinor,
        currency: effectiveCurrency,
        // Kept for backward compatibility with existing clients.
        pricePaise:
          effectiveCurrency === 'INR' ? amountMinor : null,
        priceRupees:
          effectiveCurrency === 'INR' ? amountMinor / 100 : null,
        durationDays: plan.duration_days,
        pricingSource: plan.country_price_minor != null
          ? 'country'
          : 'default',
      };
    });

    return res.json({
      product: {
        code: req.product.code,
        name: req.product.name,
      },
      pricing: {
        country: country,
        currency: currency ?? 'INR',
      },
      plans,
    });
  } catch (error) {
    console.error('Failed to retrieve plans:', error.message);

    return res.status(500).json({
      error: 'Unable to retrieve subscription plans',
    });
  }
});

export default router;

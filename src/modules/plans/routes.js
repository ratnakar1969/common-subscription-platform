
import { Router } from 'express';
import pool from '../../config/database.js';
import authenticateProduct from '../../middleware/authProduct.js';

const router = Router();

router.get('/', authenticateProduct, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, name, price_paise, duration_days
       FROM plans
       WHERE product_id = $1
         AND is_active = TRUE
       ORDER BY price_paise ASC`,
      [req.product.id]
    );

    const plans = result.rows.map((plan) => ({
      code: plan.code,
      name: plan.name,
      pricePaise: Number(plan.price_paise),
      priceRupees: Number(plan.price_paise) / 100,
      durationDays: plan.duration_days,
    }));

    return res.json({
      product: {
        code: req.product.code,
        name: req.product.name,
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

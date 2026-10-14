
import 'dotenv/config';
import { createHash } from 'node:crypto';
import pool from './config/database.js';

async function bootstrap() {
  const { PRODUCT_CODE, PRODUCT_NAME, PRODUCT_API_KEY } = process.env;

  if (!PRODUCT_CODE || !PRODUCT_NAME || !PRODUCT_API_KEY) {
    throw new Error(
      'PRODUCT_CODE, PRODUCT_NAME and PRODUCT_API_KEY must be set in .env'
    );
  }

  const apiKeyHash = createHash('sha256')
    .update(PRODUCT_API_KEY)
    .digest('hex');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productResult = await client.query(
      `INSERT INTO products (code, name, api_key_hash, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (code)
       DO UPDATE SET
         name = EXCLUDED.name,
         api_key_hash = EXCLUDED.api_key_hash,
         is_active = TRUE
       RETURNING id, code, name`,
      [PRODUCT_CODE, PRODUCT_NAME, apiKeyHash]
    );

    const product = productResult.rows[0];

    const plans = [
      { code: 'FREE', name: 'Free', pricePaise: 0, durationDays: 30 },
      { code: 'PRO', name: 'Pro', pricePaise: 59900, durationDays: 90 },
      { code: 'ELITE', name: 'Elite', pricePaise: 99900, durationDays: 180 },
    ];

    for (const plan of plans) {
      await client.query(
        `INSERT INTO plans
           (product_id, code, name, price_paise, duration_days, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (product_id, code)
         DO UPDATE SET
           name = EXCLUDED.name,
           price_paise = EXCLUDED.price_paise,
           duration_days = EXCLUDED.duration_days,
           is_active = TRUE`,
        [
          product.id,
          plan.code,
          plan.name,
          plan.pricePaise,
          plan.durationDays,
        ]
      );
    }

    await client.query('COMMIT');

    console.log('Product registered successfully:', {
      id: product.id,
      code: product.code,
      name: product.name,
    });
    console.log('Subscription plans seeded:', plans.length);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed:', error.message);
  process.exitCode = 1;
});

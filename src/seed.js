import { randomBytes, createHash } from 'node:crypto';
import pool from './config/database.js';

for (const product of ['HIRINGXCHANGE', 'SIGNPUBLIQ', 'FLATSXCHANGE']) {
  const apiKey = `csp_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  console.log(JSON.stringify({
    product,
    apiKey,
    apiKeyHash
  }));

  
const client = await pool.connect();

try {
  await client.query('BEGIN');

  // Create FREE, PRO and ELITE plans for each existing product.
  await client.query(`
    INSERT INTO plans (
      product_id,
      code,
      name,
      price_paise,
      duration_days,
      is_active
    )
    SELECT
      p.id,
      plan.code,
      plan.name,
      plan.price_paise,
      plan.duration_days,
      TRUE
    FROM products p
    CROSS JOIN (
      VALUES
        ('FREE',  'Free',  0::BIGINT,     365),
        ('PRO',   'Pro',   59900::BIGINT,  90),
        ('ELITE', 'Elite', 99900::BIGINT, 180)
    ) AS plan(code, name, price_paise, duration_days)
    WHERE p.code IN (
      'HIRINGXCHANGE',
      'SIGNPUBLIQ',
      'FLATSXCHANGE'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM plans existing
      WHERE existing.product_id = p.id
        AND existing.code = plan.code
    );
  `);

  // Create INR prices for paid plans only.
  await client.query(`
    INSERT INTO plan_prices (
      plan_id,
      country_code,
      currency,
      amount_minor,
      is_active,
      effective_from
    )
    SELECT
      pl.id,
      'IN',
      'INR',
      pl.price_paise,
      TRUE,
      NOW()
    FROM plans pl
    JOIN products p ON p.id = pl.product_id
    WHERE p.code IN (
      'HIRINGXCHANGE',
      'SIGNPUBLIQ',
      'FLATSXCHANGE'
    )
      AND pl.code IN ('PRO', 'ELITE')
      AND NOT EXISTS (
        SELECT 1
        FROM plan_prices pp
        WHERE pp.plan_id = pl.id
          AND pp.country_code = 'IN'
          AND pp.currency = 'INR'
          AND pp.is_active = TRUE
          AND pp.effective_to IS NULL
      );
  `);

  await client.query('COMMIT');
  console.log('Plans and INR pricing seeded successfully.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Seeding failed:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
}

}
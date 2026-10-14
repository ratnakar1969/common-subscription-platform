
import { createHash } from 'node:crypto';
import pool from '../config/database.js';

export default async function authenticateProduct(req, res, next) {
  try {
    const apiKey = req.get('x-product-key');

    if (!apiKey) {
      return res.status(401).json({
        error: 'Product API key is required',
      });
    }

    const apiKeyHash = createHash('sha256')
      .update(apiKey)
      .digest('hex');

    const result = await pool.query(
      `SELECT id, code, name
       FROM products
       WHERE api_key_hash = $1
         AND is_active = TRUE
       LIMIT 1`,
      [apiKeyHash]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: 'Invalid product API key',
      });
    }

    req.product = result.rows[0];
    next();
  } catch (error) {
    console.error('Product authentication failed:', error.message);

    return res.status(500).json({
      error: 'Product authentication could not be completed',
    });
  }
}

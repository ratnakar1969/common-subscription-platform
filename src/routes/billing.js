// routes/billing.js

import { Router } from 'express';
import { getPlans } from '../services/subscriptionClient.js';

const router = Router();

router.get('/plans', async (req, res) => {
  try {
    const data = await getPlans();
    return res.json(data);
  } catch (error) {
    console.error('Unable to load plans:', error.message);

    return res.status(502).json({
      error: 'Subscription service is temporarily unavailable'
    });
  }
});

export default router;
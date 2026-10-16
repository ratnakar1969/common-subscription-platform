
import express from 'express';
import helmet from 'helmet';
import plansRouter from './modules/plans/routes.js';
import { rateLimit } from 'express-rate-limit';
import ordersRouter from './modules/orders/routes.js';
import paymentsRouter from './modules/payments/routes.js';
import subscriptionRoutes from './modules/subscriptions/routes.js';
import billingRoutes from './routes/billingRoutes.js';

app.use('/api/billing', billingRoutes);

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();

app.use(express.static(path.resolve(__dirname, '../public')));


app.use(helmet());
app.use(express.json({ limit: '1mb' }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'common-subscription-platform',
  });
});
app.use('/api/plans', plansRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/entitlements', subscriptionRoutes);
app.use('/api/billing', billingRoutes);
export default app;

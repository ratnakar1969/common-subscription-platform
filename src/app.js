
import express from 'express';
import plansRouter from './modules/plans/routes.js';
import { rateLimit } from 'express-rate-limit';
import ordersRouter from './modules/orders/routes.js';
import subscriptionRoutes from './modules/subscriptions/routes.js';
import billingRoutes from './routes/billing.js';
import usageRoutes from './modules/usage/usageRoutes.js';
import paymentRoutes from "./modules/payments/routes.js";
import pinoHttp from "pino-http";
import logger from "./config/logger.js";
import helmet from 'helmet';
import cors from 'cors';



import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
// Create your Express app first.
// Allow your local frontend
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-product-key',
    'Idempotency-Key'
  ]
}));

app.use(helmet());
app.use(express.json({ limit: '1mb' }));

app.use(
  pinoHttp({
    logger,
    autoLogging: true,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);

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
app.use('/api/entitlements', subscriptionRoutes);
app.use('/api/billing', billingRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/payments", paymentRoutes);
export default app;
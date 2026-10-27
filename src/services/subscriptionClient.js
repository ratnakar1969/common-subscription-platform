// services/subscriptionClient.js

const SUBSCRIPTION_API_URL =
  process.env.SUBSCRIPTION_API_URL;

const PRODUCT_API_KEY =
  process.env.SUBSCRIPTION_PRODUCT_API_KEY;

export async function getPlans() {
  const response = await fetch(
    `${SUBSCRIPTION_API_URL}/api/plans`,
    {
      headers: {
        'x-product-key': PRODUCT_API_KEY
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Subscription API returned HTTP ${response.status}`
    );
  }
  

  return response.json();
}

export async function createOrder({
  planCode,
  externalUserId,
  idempotencyKey
}) {
  const response = await fetch(
    `${SUBSCRIPTION_API_URL}/api/orders`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-product-key': PRODUCT_API_KEY,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        planCode,
        externalUserId
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();

    throw new Error(
      `Subscription API returned HTTP ${response.status}: ${errorBody}`
    );
  }

  return response.json();
}


export async function verifyPayment({
  orderId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  idempotencyKey
}) {
  console.log("Verifying Payments");
  const response = await fetch(
    `${SUBSCRIPTION_API_URL}/api/payments/verify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-product-key': PRODUCT_API_KEY,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        orderId,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();

    throw new Error(
      `Subscription API returned HTTP ${response.status}: ${errorBody}`
    );
  }

  return response.json();
}

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

export async function getPlans({
  country = "IN",
  currency = "INR",
} = {}) {
  const query = new URLSearchParams({ country, currency });

  const response = await fetch(
    `/api/plans?${query.toString()}`,
    {
      credentials: "include",
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Unable to load subscription plans"
    );
  }

  return data;
}

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderPaid } from "../lib/invoice.server";
import type { ShopifyOrderPayload } from "../lib/fiscal/order-mapping";

// orders/paid webhook. authenticate.webhook verifies the HMAC; an invalid signature
// throws (401) before we run. Emission is idempotent + scoped by shop in
// handleOrderPaid. Infra errors propagate (→ 500) so Shopify retries; emission
// failures are recorded as ERROR (reemitível) and still return 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await handleOrderPaid(shop, payload as ShopifyOrderPayload);

  return new Response();
};

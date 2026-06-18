import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderPaid } from "../lib/invoice.server";
import type { ShopifyOrderPayload } from "../lib/fiscal/shopify-order.server";

// orders/paid webhook. authenticate.webhook verifies the HMAC; an invalid signature
// throws (401) before we run. `admin` is the offline-session GraphQL client (used to
// enrich the order with CPF/NCM) — it may be undefined, which handleOrderPaid handles.
// Emission is idempotent + scoped by shop. Infra errors propagate (→ 500, Shopify
// retries); emission failures are recorded as ERROR (reemitível) and still return 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await handleOrderPaid(shop, payload as ShopifyOrderPayload, admin);

  return new Response();
};

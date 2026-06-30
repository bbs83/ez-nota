import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import { cancelInvoiceForOrder } from "../lib/invoice-resolver.server";

// orders/cancelled: pedido cancelado INTEGRALMENTE → cancela a NF-e (se houver e for
// elegível). authenticate.webhook verifica o HMAC (401 se inválido). Idempotente
// (cancelInvoiceForOrder condiciona o update ao estado). Logs SEM PII.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = (payload as { id?: number | null })?.id;
  if (orderId == null) {
    console.log("[orders/cancelled] payload sem id de pedido; ignorando");
    return new Response();
  }

  const shopRow = await getOrCreateShop(shop);
  const outcome = await cancelInvoiceForOrder(shopRow.id, String(orderId));
  console.log(`[orders/cancelled] pedido ${orderId} → ${outcome}`);

  return new Response();
};

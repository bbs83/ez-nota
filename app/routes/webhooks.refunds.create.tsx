import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import {
  cancelInvoiceForOrder,
  markPartialRefundForOrder,
} from "../lib/invoice-resolver.server";
import { fetchOrderRefundStatus } from "../lib/fiscal/shopify-order.server";

// refunds/create: um reembolso foi criado (parcial OU total). O payload do refund não
// diz se o pedido ficou integralmente reembolsado → consulta o pedido (Admin GraphQL).
// Integral → cancela a NF-e. Parcial → só sinaliza (NÃO cancela; devolução é fluxo
// futuro). HMAC por authenticate.webhook. Idempotente. Logs SEM PII (sem valores/itens).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const orderId = (payload as { order_id?: number | null })?.order_id;
  if (orderId == null) {
    console.log("[refunds/create] payload sem order_id; ignorando");
    return new Response();
  }

  const shopRow = await getOrCreateShop(shop);

  // Sem sessão admin não dá para classificar integral vs parcial. Não cancelar às cegas
  // (cancelamento integral também chega por orders/cancelled, que não depende do admin).
  if (!admin) {
    console.warn(
      `[refunds/create] pedido ${orderId}: sessão admin indisponível; classificação ignorada`,
    );
    return new Response();
  }

  let fullyRefunded: boolean;
  try {
    const status = await fetchOrderRefundStatus(
      admin,
      `gid://shopify/Order/${orderId}`,
    );
    fullyRefunded = status.fullyRefunded;
  } catch {
    // L5: não decidir com dados degradados — relança para o Shopify reenviar (→ 500).
    console.error(`[refunds/create] consulta do pedido ${orderId} no Shopify falhou`);
    throw new Error(`refund status fetch failed (${orderId})`);
  }

  if (fullyRefunded) {
    const outcome = await cancelInvoiceForOrder(shopRow.id, String(orderId));
    console.log(`[refunds/create] pedido ${orderId} integral → ${outcome}`);
  } else {
    const flagged = await markPartialRefundForOrder(shopRow.id, String(orderId));
    console.log(
      `[refunds/create] pedido ${orderId} parcial → sinalizado=${flagged} (NF-e mantida)`,
    );
  }

  return new Response();
};

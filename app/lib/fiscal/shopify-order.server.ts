import { isValidCnpj, isValidCpf } from "../validation/br-documents";

// Fetches the order data NF-e emission needs from Shopify. The GraphQL query is the
// primary source (it carries the BR CPF/CNPJ via localizedFields and the per-variant
// NCM via inventoryItem.countryHarmonizedSystemCodes — neither is in the webhook
// payload). A webhook-payload fallback covers the case where the admin client is
// unavailable. Field names + scopes validated via the Shopify Dev MCP (Admin 2026-07):
// the query needs only read_orders (+ read_products, already covered by write_products).
//
// LGPD/L8: NEVER log the returned data (CPF, address are personal).

/** Minimal admin GraphQL client (structural, to avoid coupling to the SDK type). */
export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

export interface FiscalOrderAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCode: string | null;
  phone: string | null;
}

export interface FiscalOrderLine {
  /** Numeric variant id as string (matches ProductFiscalMapping.shopifyVariantId). */
  variantId: string | null;
  descricao: string;
  sku: string | null;
  quantidade: number;
  valorUnitario: number;
  /** Brazil country-specific HS code (NCM) from the variant, if registered. */
  hsCodeBr: string | null;
}

export interface FiscalOrder {
  nome: string | null;
  email: string | null;
  cpfCnpj: string | null;
  enderecoEntrega: FiscalOrderAddress | null;
  itens: FiscalOrderLine[];
  /** True if the order has more line items than we fetched (>100) — do not under-report. */
  lineItemsTruncated: boolean;
  valorProdutos: number;
  valorFrete: number;
  valorDesconto: number;
  valorTotal: number;
}

// --- Webhook payload (REST-ish JSON delivered to orders/paid) -------------

export interface ShopifyAddress {
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  zip?: string | null;
  phone?: string | null;
  country_code?: string | null;
}
export interface ShopifyLineItem {
  variant_id?: number | null;
  title?: string | null;
  name?: string | null;
  sku?: string | null;
  quantity?: number | null;
  price?: string | null;
}
export interface ShopifyOrderPayload {
  id?: number | null;
  name?: string | null;
  email?: string | null;
  total_price?: string | null;
  total_discounts?: string | null;
  total_shipping_price_set?: { shop_money?: { amount?: string | null } | null } | null;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[] | null;
  note_attributes?: Array<{ name?: string | null; value?: string | null }> | null;
}

// --- GraphQL ---------------------------------------------------------------

export const ORDER_QUERY = `#graphql
  query OrderForNfe($id: ID!) {
    order(id: $id) {
      id
      name
      email
      subtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      localizedFields(first: 20) {
        nodes { key value countryCode purpose }
      }
      shippingAddress {
        name address1 address2 city province provinceCode zip country countryCodeV2 phone company
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          name
          sku
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          variant {
            id
            inventoryItem {
              countryHarmonizedSystemCodes(first: 5) {
                nodes { harmonizedSystemCode countryCode }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

// Consulta enxuta para classificar um refund: integral vs parcial. Campos + scope
// (read_orders) validados via Dev MCP (Admin 2026-04).
export const ORDER_REFUND_STATUS_QUERY = `#graphql
  query OrderRefundStatus($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
      totalRefundedSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
    }
  }
`;

export interface OrderRefundStatus {
  /** True se o pedido está INTEGRALMENTE reembolsado (→ elegível a cancelar a NF-e). */
  fullyRefunded: boolean;
}

function num(value: unknown): number {
  const n = parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function digitsOf(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Numeric id from a GID like "gid://shopify/ProductVariant/123". */
function gidToNumeric(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const tail = gid.split("/").pop() ?? "";
  return /^\d+$/.test(tail) ? tail : null;
}

/** CPF/CNPJ digits if valid, else null. */
function validDocument(value: unknown): string | null {
  const d = digitsOf(value);
  if (d.length === 11 && isValidCpf(d)) return d;
  if (d.length === 14 && isValidCnpj(d)) return d;
  return null;
}

/**
 * CPF/CNPJ from localizedFields — ONLY the Brazil tax credential
 * (key TAX_CREDENTIAL_BR + countryCode BR + purpose TAX), and only if the check
 * digits are valid. No loose digit-length fallback (would risk grabbing another
 * numeric field). Confirmed via Dev MCP.
 */
function cpfCnpjFromLocalizedFields(
  nodes: Array<{
    key?: string | null;
    value?: string | null;
    countryCode?: string | null;
    purpose?: string | null;
  }>,
): string | null {
  for (const node of nodes) {
    if ((node.key ?? "") !== "TAX_CREDENTIAL_BR") continue;
    if ((node.countryCode ?? "") !== "BR") continue;
    if ((node.purpose ?? "") !== "TAX") continue;
    const doc = validDocument(node.value);
    if (doc) return doc;
  }
  return null;
}

/** Brazil country-specific HS code (NCM) from the variant's inventory item. */
function hsCodeBrFromNodes(
  nodes: Array<{ harmonizedSystemCode?: string | null; countryCode?: string | null }>,
): string | null {
  const br = nodes.find((n) => (n.countryCode ?? "") === "BR");
  return br?.harmonizedSystemCode ?? null;
}

interface GqlMoney {
  shopMoney?: { amount?: string | null } | null;
}
interface GqlOrder {
  name?: string | null;
  email?: string | null;
  subtotalPriceSet?: GqlMoney | null;
  totalShippingPriceSet?: GqlMoney | null;
  totalDiscountsSet?: GqlMoney | null;
  totalPriceSet?: GqlMoney | null;
  localizedFields?: {
    nodes?: Array<{
      key?: string | null;
      value?: string | null;
      countryCode?: string | null;
      purpose?: string | null;
    }>;
  } | null;
  shippingAddress?: {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    provinceCode?: string | null;
    zip?: string | null;
    countryCodeV2?: string | null;
    phone?: string | null;
  } | null;
  lineItems?: {
    nodes?: Array<{
      title?: string | null;
      name?: string | null;
      sku?: string | null;
      quantity?: number | null;
      originalUnitPriceSet?: GqlMoney | null;
      variant?: {
        id?: string | null;
        inventoryItem?: {
          countryHarmonizedSystemCodes?: {
            nodes?: Array<{ harmonizedSystemCode?: string | null; countryCode?: string | null }>;
          } | null;
        } | null;
      } | null;
    }>;
    pageInfo?: { hasNextPage?: boolean } | null;
  } | null;
}

function normalizeGqlOrder(order: GqlOrder): FiscalOrder {
  const lineNodes = order.lineItems?.nodes ?? [];
  const itens: FiscalOrderLine[] = lineNodes.map((li) => ({
    variantId: gidToNumeric(li.variant?.id),
    descricao: li.title ?? li.name ?? "Item",
    sku: li.sku ?? null,
    quantidade: li.quantity ?? 1,
    valorUnitario: num(li.originalUnitPriceSet?.shopMoney?.amount),
    hsCodeBr: hsCodeBrFromNodes(
      li.variant?.inventoryItem?.countryHarmonizedSystemCodes?.nodes ?? [],
    ),
  }));

  const valorProdutos = round2(
    itens.reduce((sum, i) => sum + i.quantidade * i.valorUnitario, 0),
  );
  const valorFrete = num(order.totalShippingPriceSet?.shopMoney?.amount);
  const valorDesconto = num(order.totalDiscountsSet?.shopMoney?.amount);
  const valorTotal =
    num(order.totalPriceSet?.shopMoney?.amount) ||
    round2(valorProdutos - valorDesconto + valorFrete);

  const sa = order.shippingAddress;

  return {
    nome: sa?.name?.trim() || null, // recipient name (read_orders; avoids read_customers)
    email: order.email ?? null,
    cpfCnpj: cpfCnpjFromLocalizedFields(order.localizedFields?.nodes ?? []),
    enderecoEntrega: sa
      ? {
          address1: sa.address1 ?? null,
          address2: sa.address2 ?? null,
          city: sa.city ?? null,
          provinceCode: (sa.provinceCode ?? "").toUpperCase() || null,
          zip: sa.zip ?? null,
          countryCode: sa.countryCodeV2 ?? null,
          phone: sa.phone ?? null,
        }
      : null,
    itens,
    lineItemsTruncated: order.lineItems?.pageInfo?.hasNextPage ?? false,
    valorProdutos,
    valorFrete,
    valorDesconto,
    valorTotal,
  };
}

/**
 * Primary path: enrich via Admin GraphQL. Throws on GraphQL errors / missing order
 * (L5) so the caller treats it as a failure instead of emitting on degraded data.
 */
export async function fetchFiscalOrder(
  admin: AdminGraphqlClient,
  orderGid: string,
): Promise<FiscalOrder> {
  const response = await admin.graphql(ORDER_QUERY, {
    variables: { id: orderGid },
  });
  const body = (await response.json()) as {
    data?: { order?: GqlOrder | null };
    errors?: unknown[];
  };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error("GraphQL errors querying order");
  }
  const order = body?.data?.order;
  if (!order) throw new Error("Order not found");
  return normalizeGqlOrder(order);
}

/**
 * Classifica um refund: integral vs parcial. Integral = displayFinancialStatus REFUNDED
 * OU total reembolsado >= total do pedido. Lança em erro de GraphQL / pedido ausente
 * (L5) para o chamador reenfileirar (reenvio do webhook). Não logar os valores (L8).
 */
export async function fetchOrderRefundStatus(
  admin: AdminGraphqlClient,
  orderGid: string,
): Promise<OrderRefundStatus> {
  const response = await admin.graphql(ORDER_REFUND_STATUS_QUERY, {
    variables: { id: orderGid },
  });
  const body = (await response.json()) as {
    data?: {
      order?: {
        displayFinancialStatus?: string | null;
        totalRefundedSet?: GqlMoney | null;
        totalPriceSet?: GqlMoney | null;
      } | null;
    };
    errors?: unknown[];
  };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error("GraphQL errors querying order refund status");
  }
  const order = body?.data?.order;
  if (!order) throw new Error("Order not found");

  const refunded = num(order.totalRefundedSet?.shopMoney?.amount);
  const total = num(order.totalPriceSet?.shopMoney?.amount);
  const fullyRefunded =
    (order.displayFinancialStatus ?? "") === "REFUNDED" ||
    (total > 0 && refunded >= total);
  return { fullyRefunded };
}

/** Fallback: build from the webhook payload (no NCM-by-variant; CPF only via note_attributes). */
export function fiscalOrderFromWebhookPayload(
  payload: ShopifyOrderPayload,
): FiscalOrder {
  const lines = payload.line_items ?? [];
  const itens: FiscalOrderLine[] = lines.map((li) => ({
    variantId: li.variant_id != null ? String(li.variant_id) : null,
    descricao: li.title ?? li.name ?? "Item",
    sku: li.sku ?? null,
    quantidade: li.quantity ?? 1,
    valorUnitario: num(li.price),
    hsCodeBr: null,
  }));
  const valorProdutos = round2(
    itens.reduce((sum, i) => sum + i.quantidade * i.valorUnitario, 0),
  );
  const valorFrete = num(payload.total_shipping_price_set?.shop_money?.amount);
  const valorDesconto = num(payload.total_discounts);
  const valorTotal =
    num(payload.total_price) || round2(valorProdutos - valorDesconto + valorFrete);

  let cpfCnpj: string | null = null;
  for (const attr of payload.note_attributes ?? []) {
    const key = (attr?.name ?? "").toLowerCase();
    if (key.includes("cpf") || key.includes("cnpj") || key.includes("documento")) {
      const doc = validDocument(attr?.value);
      if (doc) {
        cpfCnpj = doc;
        break;
      }
    }
  }

  const sa = payload.shipping_address ?? payload.billing_address;
  const nome =
    sa?.name?.trim() ||
    [payload.customer?.first_name, payload.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    null;

  return {
    nome,
    email: payload.email ?? null,
    cpfCnpj,
    enderecoEntrega: sa
      ? {
          address1: sa.address1 ?? null,
          address2: sa.address2 ?? null,
          city: sa.city ?? null,
          provinceCode: (sa.province_code ?? "").toUpperCase() || null,
          zip: sa.zip ?? null,
          countryCode: sa.country_code ?? null,
          phone: sa.phone ?? null,
        }
      : null,
    itens,
    lineItemsTruncated: false,
    valorProdutos,
    valorFrete,
    valorDesconto,
    valorTotal,
  };
}

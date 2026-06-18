import prisma from "../../db.server";
import type { AdminGraphqlClient } from "./shopify-order.server";
import {
  resolveVariantFiscalConfig,
  type FiscalConfigDefaults,
  type VariantFiscalConfig,
} from "./variant-fiscal-config.server";

// Read-only fiscal catalog: lists store variants with the resolved fiscal config
// (NCM/CFOP/CSOSN/origem + source) using the SHARED resolver — no reimplementation.
// Field names validated via Dev MCP (Admin 2026-07). Uses read_products (we have it
// via write_products). LGPD: no customer data here.

export const PRODUCTS_QUERY = `#graphql
  query CatalogProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            inventoryItem {
              countryHarmonizedSystemCodes(first: 5) {
                nodes { harmonizedSystemCode countryCode }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export interface CatalogVariantRow {
  /** Numeric variant id (matches ProductFiscalMapping.shopifyVariantId). */
  variantId: string | null;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  price: string;
  /** HS code BR do variant — enviado na action de edição para re-resolver sem re-buscar. */
  hsCodeBr: string | null;
  fiscal: VariantFiscalConfig;
  /** Valores brutos do override (para pré-preencher o form); null sem mapping. */
  mapping: {
    ncm: string | null;
    cfop: string | null;
    csosn: string | null;
    origem: string | null;
  } | null;
}

export interface CatalogPage {
  rows: CatalogVariantRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlHsNode {
  harmonizedSystemCode?: string | null;
  countryCode?: string | null;
}
interface GqlVariant {
  id?: string | null;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  inventoryItem?: {
    countryHarmonizedSystemCodes?: { nodes?: GqlHsNode[] } | null;
  } | null;
}
interface GqlProduct {
  title?: string | null;
  variants?: { nodes?: GqlVariant[] } | null;
}
interface GqlProducts {
  nodes?: GqlProduct[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

function gidToNumeric(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const tail = gid.split("/").pop() ?? "";
  return /^\d+$/.test(tail) ? tail : null;
}

function brHsCode(nodes: GqlHsNode[]): string | null {
  const br = nodes.find((n) => (n.countryCode ?? "") === "BR");
  return br?.harmonizedSystemCode ?? null;
}

export async function fetchCatalogPage(
  admin: AdminGraphqlClient,
  args: {
    shopId: string;
    defaults: FiscalConfigDefaults;
    query?: string;
    after?: string;
    pageSize?: number;
  },
): Promise<CatalogPage> {
  const first = args.pageSize ?? 50;
  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: {
      first,
      after: args.after ?? null,
      query: args.query ?? null,
    },
  });
  const body = (await response.json()) as { data?: { products?: GqlProducts } };
  const products = body?.data?.products;

  // Flatten products → variants.
  const flat: Array<{ productTitle: string; variant: GqlVariant }> = [];
  for (const product of products?.nodes ?? []) {
    for (const variant of product.variants?.nodes ?? []) {
      flat.push({ productTitle: product.title ?? "", variant });
    }
  }

  // Batch read ProductFiscalMapping for this page's variants (scoped by shopId).
  const variantIds = flat
    .map((f) => gidToNumeric(f.variant.id))
    .filter((v): v is string => !!v);
  const mappings = variantIds.length
    ? await prisma.productFiscalMapping.findMany({
        where: { shopId: args.shopId, shopifyVariantId: { in: variantIds } },
        select: {
          shopifyVariantId: true,
          ncm: true,
          cfop: true,
          csosn: true,
          origem: true,
        },
      })
    : [];
  const mapByVariant = new Map(mappings.map((m) => [m.shopifyVariantId, m]));

  const rows: CatalogVariantRow[] = flat.map(({ productTitle, variant }) => {
    const variantId = gidToNumeric(variant.id);
    const m = variantId ? (mapByVariant.get(variantId) ?? null) : null;
    const hsCodeBr = brHsCode(
      variant.inventoryItem?.countryHarmonizedSystemCodes?.nodes ?? [],
    );
    const fiscal = resolveVariantFiscalConfig({
      hsCodeBr,
      mapping: m,
      defaults: args.defaults,
    });
    return {
      variantId,
      productTitle,
      variantTitle: variant.title ?? "",
      sku: variant.sku ?? null,
      price: variant.price ?? "",
      hsCodeBr,
      fiscal,
      mapping: m
        ? { ncm: m.ncm, cfop: m.cfop, csosn: m.csosn, origem: m.origem }
        : null,
    };
  });

  return {
    rows,
    hasNextPage: products?.pageInfo?.hasNextPage ?? false,
    endCursor: products?.pageInfo?.endCursor ?? null,
  };
}

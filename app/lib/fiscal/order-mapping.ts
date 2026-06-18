import type {
  Emitente,
  FiscalSettings,
  ProductFiscalMapping,
} from "@prisma/client";
import type { EmissionItem, EmitInvoiceInput } from "./types";

// Maps a Shopify orders/paid payload (+ our Emitente/FiscalSettings/mappings) into
// the engine-agnostic EmitInvoiceInput. No engine wire format here.
//
// ⚠️ PREMISSAS A VALIDAR (CLAUDE.md: FLAG):
//  - Endereço do destinatário: o Shopify guarda a rua inteira em `address1` e NÃO
//    separa número/bairro; bairro/IBGE não vêm no payload. Tratado como best-effort
//    até o módulo de correção de endereço (MVP passo 5). número => "S/N" se ausente.
//  - CPF/CNPJ do cliente: o Shopify não tem campo nativo; tentamos `note_attributes`
//    (chave contendo "cpf"/"cnpj"/"documento"). Ausente => consumidor não identificado.
//  - unidade comercial "UN" fixa; produtos do Shopify não carregam unidade fiscal.
//  - valor_total = total_price do pedido; itens usam line_item.price (sem rateio de
//    frete/desconto). Pode divergir do somatório — rever no mapeamento fino.

export interface ShopifyAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  province?: string | null;
  zip?: string | null;
  phone?: string | null;
  company?: string | null;
  name?: string | null;
}

export interface ShopifyLineItem {
  id?: number | null;
  variant_id?: number | null;
  product_id?: number | null;
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
  currency?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
  billing_address?: ShopifyAddress | null;
  shipping_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[] | null;
  note_attributes?: Array<{ name?: string | null; value?: string | null }> | null;
}

type EmitenteWithSettings = Emitente & { fiscalSettings: FiscalSettings };

function toNumber(value: string | null | undefined): number {
  const n = parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Best-effort CPF/CNPJ extraction from note_attributes. */
function extractCpfCnpj(order: ShopifyOrderPayload): string | null {
  for (const attr of order.note_attributes ?? []) {
    const key = (attr?.name ?? "").toLowerCase();
    if (key.includes("cpf") || key.includes("cnpj") || key.includes("documento")) {
      const value = (attr?.value ?? "").replace(/\D/g, "");
      if (value.length === 11 || value.length === 14) return value;
    }
  }
  return null;
}

function mapAddress(addr: ShopifyAddress | null | undefined) {
  if (!addr) return null;
  return {
    logradouro: addr.address1 ?? "",
    numero: "S/N", // FLAG: Shopify não separa número; corrigir no módulo de endereço.
    complemento: addr.address2 ?? null,
    bairro: "", // FLAG: Shopify não tem bairro; preencher via correção de endereço.
    codigoMunicipioIbge: "", // FLAG: não vem do Shopify; Focus deriva por município+UF.
    municipio: addr.city ?? "",
    uf: (addr.province_code ?? "").toUpperCase(),
    cep: (addr.zip ?? "").replace(/\D/g, ""),
  };
}

export function buildEmissionInput(args: {
  emitente: EmitenteWithSettings;
  order: ShopifyOrderPayload;
  productMappings: Map<string, ProductFiscalMapping>;
  numero: number;
}): EmitInvoiceInput {
  const { emitente, order, productMappings, numero } = args;
  const settings = emitente.fiscalSettings;

  const itens: EmissionItem[] = (order.line_items ?? []).map((li) => {
    const variantId = li.variant_id != null ? String(li.variant_id) : "";
    const mapping = variantId ? productMappings.get(variantId) : undefined;
    const quantidade = li.quantity ?? 1;
    const valorUnitario = toNumber(li.price);
    return {
      codigo: li.sku || variantId || (li.id != null ? String(li.id) : ""),
      descricao: li.title ?? li.name ?? "Item",
      quantidade,
      valorUnitario,
      valorTotal: round2(quantidade * valorUnitario),
      unidade: "UN", // FLAG
      // ProductFiscalMapping por variante, senão defaults do FiscalSettings.
      ncm: mapping?.ncm || settings.defaultNcm || "",
      cfop: mapping?.cfop || settings.defaultCfop,
      csosn: mapping?.csosn || settings.defaultCsosn,
      origem: mapping?.origem || settings.defaultOrigem,
    };
  });

  const valorProdutos = round2(
    itens.reduce((sum, item) => sum + item.valorTotal, 0),
  );
  const valorTotal = order.total_price ? toNumber(order.total_price) : valorProdutos;

  const customerName = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const shippingOrBilling = order.shipping_address ?? order.billing_address;

  return {
    ambiente: settings.ambiente,
    tipoDocumento: settings.tipoDocumento,
    serie: settings.serie,
    numero,
    naturezaOperacao: settings.naturezaOperacao,
    emitente: {
      cnpj: emitente.cnpj,
      razaoSocial: emitente.razaoSocial,
      nomeFantasia: emitente.nomeFantasia,
      inscricaoEstadual: emitente.inscricaoEstadual,
      regimeTributario: emitente.regimeTributario,
      endereco: {
        logradouro: emitente.logradouro,
        numero: emitente.numero,
        complemento: emitente.complemento,
        bairro: emitente.bairro,
        codigoMunicipioIbge: emitente.codigoMunicipioIbge,
        municipio: emitente.municipio,
        uf: emitente.uf,
        cep: emitente.cep,
      },
    },
    destinatario: {
      nome: customerName || shippingOrBilling?.name || "Consumidor final",
      cpfCnpj: extractCpfCnpj(order),
      email: order.customer?.email ?? order.email ?? null,
      telefone: shippingOrBilling?.phone ?? null,
      endereco: mapAddress(shippingOrBilling),
    },
    itens,
    valorProdutos,
    valorTotal,
    idempotencyKey: `${emitente.shopId}:${order.id ?? ""}`,
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

import type {
  Emitente,
  FiscalSettings,
  ProductFiscalMapping,
} from "@prisma/client";
import { onlyDigits } from "../validation/br-documents";
import { parseEnderecoLogradouro } from "./address-parsing";
import type { CepLookupResult } from "../lookup/types";
import type { EmissionItem, EmitInvoiceInput } from "./types";
import type { FiscalOrder } from "./shopify-order.server";
import { resolveVariantFiscalConfig } from "./variant-fiscal-config.server";

// Maps a normalized FiscalOrder (+ Emitente/FiscalSettings/mappings/ViaCEP) into the
// engine-agnostic EmitInvoiceInput. No engine wire format here. Returns an error
// instead of an invalid payload when a product has no valid NCM.
//
// ⚠️ PREMISSAS A VALIDAR COM CONTADOR (CLAUDE.md: FLAG):
//  - CFOP por cenário: mantemos os 3 últimos dígitos do CFOP configurado e ajustamos
//    o prefixo (5=interna, 6=interestadual, 7=exterior). O CFOP real depende da
//    natureza da operação/produto — premissa para venda comum.
//  - Endereço do destinatário: Shopify não separa número/bairro; bairro/município/IBGE
//    vêm do ViaCEP (best-effort) e o número fica "S/N" até o módulo de correção (passo 5).
//  - unidade comercial "UN" fixa; consumidor final PF (indicador IE = 9 no payload).

type EmitenteWithSettings = Emitente & { fiscalSettings: FiscalSettings };

export type BuildEmissionResult =
  | { ok: true; input: Omit<EmitInvoiceInput, "numero"> }
  | { ok: false; error: string };

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function deriveDestino(
  emitenteUf: string,
  destUf: string,
  destCountry: string,
): EmitInvoiceInput["destinoOperacao"] {
  if (destCountry && destCountry.toUpperCase() !== "BR") return "EXTERIOR";
  if (!destUf) return "INTERNA"; // FLAG: sem UF do destinatário → assume interna
  return destUf.toUpperCase() === emitenteUf.toUpperCase()
    ? "INTERNA"
    : "INTERESTADUAL";
}

/** Mantém os 3 últimos dígitos do CFOP e ajusta o prefixo ao cenário. */
function adjustCfop(
  cfop: string,
  destino: EmitInvoiceInput["destinoOperacao"],
): string {
  const d = onlyDigits(cfop);
  if (d.length !== 4) return cfop; // FLAG: CFOP malformado — mantém como veio
  const prefix = destino === "EXTERIOR" ? "7" : destino === "INTERESTADUAL" ? "6" : "5";
  return prefix + d.slice(1);
}

export function buildEmissionInput(args: {
  emitente: EmitenteWithSettings;
  order: FiscalOrder;
  productMappings: Map<string, ProductFiscalMapping>;
  idempotencyKey: string;
  destinatarioCep: CepLookupResult | null;
}): BuildEmissionResult {
  const { emitente, order, productMappings, idempotencyKey, destinatarioCep } = args;
  const settings = emitente.fiscalSettings;
  const endereco = order.enderecoEntrega;

  const destino = deriveDestino(
    emitente.uf,
    endereco?.provinceCode ?? "",
    endereco?.countryCode ?? "",
  );

  // M6 (parcial): app é Brazil-only — não tentar emitir nota para o exterior.
  if (destino === "EXTERIOR") {
    return {
      ok: false,
      error:
        "Emissão para o exterior não é suportada no MVP (destino fora do Brasil).",
    };
  }
  // L1: não sub-reportar pedidos com mais de 100 itens (truncados na busca).
  if (order.lineItemsTruncated) {
    return {
      ok: false,
      error: "Pedido com mais de 100 itens não é suportado nesta versão.",
    };
  }

  const itens: EmissionItem[] = [];
  for (const line of order.itens) {
    const mapping = line.variantId
      ? productMappings.get(line.variantId)
      : undefined;
    // Resolução fiscal compartilhada (a mesma que o catálogo usará).
    const config = resolveVariantFiscalConfig({
      hsCodeBr: line.hsCodeBr,
      mapping: mapping ?? null,
      defaults: settings,
    });
    if (config.ncm.source === "none") {
      // Não envia NCM vazio: marca a Invoice como ERROR identificando o produto.
      return {
        ok: false,
        error:
          `Produto sem NCM válido (8 dígitos): "${line.descricao}"` +
          `${line.variantId ? ` (variante ${line.variantId})` : ""}. ` +
          `Configure o NCM do produto no catálogo.`,
      };
    }
    itens.push({
      codigo: line.sku || line.variantId || "",
      descricao: line.descricao,
      quantidade: line.quantidade,
      valorUnitario: line.valorUnitario,
      valorTotal: round2(line.quantidade * line.valorUnitario),
      unidade: "UN", // FLAG
      ncm: config.ncm.value,
      // CFOP-base resolvido + ajuste por destino (intra/inter) — inalterado.
      cfop: adjustCfop(config.cfop.value, destino),
      csosn: config.csosn.value,
      origem: config.origem.value,
    });
  }

  const valorProdutos = round2(itens.reduce((s, i) => s + i.valorTotal, 0));
  const valorFrete = round2(order.valorFrete);
  const valorDesconto = round2(order.valorDesconto);
  const valorTotal = round2(valorProdutos - valorDesconto + valorFrete);

  // Shopify não separa número: extraímos do address1 (heurística conservadora).
  // complemento: o campo address2 (explícito) tem prioridade; só usamos o texto
  // que sobrou do address1 (ex.: "fundos") quando address2 está vazio.
  const parsedLogradouro = parseEnderecoLogradouro(endereco?.address1);
  const address2 = (endereco?.address2 ?? "").trim();
  const complementoDest = address2 || parsedLogradouro.complemento || null;

  const destinatarioEndereco = endereco
    ? {
        logradouro:
          parsedLogradouro.logradouro || destinatarioCep?.logradouro || "",
        numero: parsedLogradouro.numero, // "S/N" quando não identificável
        complemento: complementoDest,
        bairro: destinatarioCep?.bairro || address2 || "", // FLAG
        codigoMunicipioIbge: destinatarioCep?.codigoMunicipioIbge || "",
        municipio: destinatarioCep?.municipio || endereco.city || "",
        uf: endereco.provinceCode || destinatarioCep?.uf || "",
        cep: onlyDigits(endereco.zip ?? ""),
      }
    : null;

  const input: Omit<EmitInvoiceInput, "numero"> = {
    ambiente: settings.ambiente,
    tipoDocumento: settings.tipoDocumento,
    serie: settings.serie,
    naturezaOperacao: settings.naturezaOperacao,
    destinoOperacao: destino,
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
      nome: order.nome || "Consumidor final",
      cpfCnpj: order.cpfCnpj,
      email: order.email,
      telefone: endereco?.phone ?? null,
      endereco: destinatarioEndereco,
    },
    itens,
    valorProdutos,
    valorFrete,
    valorDesconto,
    valorTotal,
    idempotencyKey,
  };

  return { ok: true, input };
}

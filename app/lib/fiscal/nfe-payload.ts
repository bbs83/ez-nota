import type { EmitInvoiceInput } from "./types";

// Builds the Focus NFe v2 request body from our engine-agnostic EmitInvoiceInput.
// This is the ONLY module (besides focus-nfe.adapter) that knows Focus's wire
// format — field names verified against https://doc.focusnfe.com.br/reference/emitir_nfe
// (do not invent fields).
//
// ⚠️ PREMISSAS FISCAIS A VALIDAR COM CONTADOR (CLAUDE.md: FLAG, não assuma):
//  - CSOSN vs CST: para Simples Nacional o código vai em `icms_situacao_tributaria`
//    (sobrecarregado: CST no Regime Normal, CSOSN no Simples). Confirmar na referência
//    de campos (campos.focusnfe.com.br) e com contador.
//  - PIS/COFINS `*_situacao_tributaria`: usando "49" (Outras Operações) como premissa
//    para Simples. PRECISA de validação contábil.
//  - CFOP x local_destino: CFOP 5xxx = intraestadual, 6xxx = interestadual. Aqui o CFOP
//    vem do ProductFiscalMapping/defaults e pode não casar com a UF do destinatário.
//  - presenca_comprador=2 (não presencial/internet) e modalidade_frete=9 (sem transporte):
//    premissas de e-commerce; rever quando houver frete/retirada.
//  - data_emissao em UTC (toISOString); confirmar fuso esperado pela SEFAZ/Focus.
//  - valor_total = valor_produtos (sem frete/desconto). Focus rejeita (cod. 598) se o
//    total não bater com o somatório quando houver outros valores.

/** CRT (Código de Regime Tributário) por RegimeTributario. */
const CRT_BY_REGIME: Record<string, number> = {
  SIMPLES_NACIONAL: 1,
  SIMPLES_EXCESSO_SUBLIMITE: 2,
  REGIME_NORMAL: 3,
  SIMPLES_NACIONAL_MEI: 4,
};

export interface FocusNfeItem {
  numero_item: number;
  codigo_produto: string;
  descricao: string;
  cfop: string;
  codigo_ncm: string;
  unidade_comercial: string;
  quantidade_comercial: number;
  valor_unitario_comercial: number;
  unidade_tributavel: string;
  quantidade_tributavel: number;
  valor_unitario_tributavel: number;
  valor_bruto: number;
  inclui_no_total: number;
  icms_origem: string;
  icms_situacao_tributaria: string;
  pis_situacao_tributaria: string;
  cofins_situacao_tributaria: string;
}

export interface FocusNfePayload {
  natureza_operacao: string;
  data_emissao: string;
  tipo_documento: number;
  finalidade_emissao: number;
  consumidor_final: number;
  presenca_comprador: number;
  modalidade_frete: number;
  local_destino: number;
  // Emitente
  cnpj_emitente: string;
  nome_emitente: string;
  nome_fantasia_emitente?: string;
  logradouro_emitente: string;
  numero_emitente: string;
  bairro_emitente: string;
  municipio_emitente: string;
  uf_emitente: string;
  cep_emitente: string;
  inscricao_estadual_emitente: string;
  regime_tributario_emitente: number;
  // Destinatário
  nome_destinatario: string;
  cpf_destinatario?: string;
  cnpj_destinatario?: string;
  indicador_inscricao_estadual_destinatario: number;
  logradouro_destinatario?: string;
  numero_destinatario?: string;
  complemento_destinatario?: string;
  bairro_destinatario?: string;
  municipio_destinatario?: string;
  uf_destinatario?: string;
  cep_destinatario?: string;
  telefone_destinatario?: string;
  // Totais + itens
  valor_produtos: number;
  valor_total: number;
  items: FocusNfeItem[];
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

export function buildFocusNfePayload(input: EmitInvoiceInput): FocusNfePayload {
  const { emitente, destinatario } = input;
  const crt = CRT_BY_REGIME[emitente.regimeTributario] ?? 1; // FLAG: default Simples

  // local_destino: 1 = interna, 2 = interestadual (derivado da UF). FLAG: o CFOP
  // precisa casar (5xxx intra / 6xxx inter) — hoje vem dos defaults/mapping.
  const mesmaUf =
    !!destinatario.endereco && destinatario.endereco.uf === emitente.endereco.uf;
  const localDestino = mesmaUf ? 1 : 2;

  const cpfCnpj = digits(destinatario.cpfCnpj);

  const items: FocusNfeItem[] = input.itens.map((item, index) => ({
    numero_item: index + 1,
    codigo_produto: item.codigo,
    descricao: item.descricao,
    cfop: item.cfop,
    codigo_ncm: digits(item.ncm),
    unidade_comercial: item.unidade,
    quantidade_comercial: item.quantidade,
    valor_unitario_comercial: item.valorUnitario,
    unidade_tributavel: item.unidade,
    quantidade_tributavel: item.quantidade,
    valor_unitario_tributavel: item.valorUnitario,
    valor_bruto: item.valorTotal,
    inclui_no_total: 1,
    icms_origem: item.origem,
    // FLAG: para Simples, CSOSN vai aqui; para Regime Normal seria o CST.
    icms_situacao_tributaria: item.csosn ?? item.cst ?? "",
    // FLAG: premissa para Simples — validar com contador.
    pis_situacao_tributaria: "49",
    cofins_situacao_tributaria: "49",
  }));

  const payload: FocusNfePayload = {
    natureza_operacao: input.naturezaOperacao,
    data_emissao: new Date().toISOString(),
    tipo_documento: 1, // 1 = saída. FLAG (devolução usaria entrada=0)
    finalidade_emissao: 1, // 1 = normal. FLAG (devolução=4, ajuste=3...)
    consumidor_final: 1, // venda a consumidor final. FLAG
    presenca_comprador: 2, // 2 = não presencial (internet). FLAG
    modalidade_frete: 9, // 9 = sem ocorrência de transporte. FLAG
    local_destino: localDestino,
    cnpj_emitente: digits(emitente.cnpj),
    nome_emitente: emitente.razaoSocial,
    ...(emitente.nomeFantasia
      ? { nome_fantasia_emitente: emitente.nomeFantasia }
      : {}),
    logradouro_emitente: emitente.endereco.logradouro,
    numero_emitente: emitente.endereco.numero,
    bairro_emitente: emitente.endereco.bairro,
    municipio_emitente: emitente.endereco.municipio,
    uf_emitente: emitente.endereco.uf,
    cep_emitente: digits(emitente.endereco.cep),
    inscricao_estadual_emitente: emitente.inscricaoEstadual,
    regime_tributario_emitente: crt,
    nome_destinatario: destinatario.nome,
    // 9 = não contribuinte (consumidor final). FLAG: se o destinatário for
    // contribuinte (CNPJ com IE), isso muda.
    indicador_inscricao_estadual_destinatario: 9,
    valor_produtos: round2(input.valorProdutos),
    valor_total: round2(input.valorTotal),
    items,
  };

  // CPF (11) vs CNPJ (14); ausente => consumidor não identificado. FLAG: em
  // produção a NF-e a consumidor pode exigir CPF dependendo do valor/UF.
  if (cpfCnpj.length === 11) payload.cpf_destinatario = cpfCnpj;
  else if (cpfCnpj.length === 14) payload.cnpj_destinatario = cpfCnpj;

  const addr = destinatario.endereco;
  if (addr) {
    // FLAG: o modelo de endereço do Shopify não separa número/bairro; isso vem do
    // módulo de correção de endereço (MVP passo 5). Aqui é best-effort.
    payload.logradouro_destinatario = addr.logradouro;
    payload.numero_destinatario = addr.numero;
    if (addr.complemento) payload.complemento_destinatario = addr.complemento;
    payload.bairro_destinatario = addr.bairro;
    payload.municipio_destinatario = addr.municipio;
    payload.uf_destinatario = addr.uf;
    payload.cep_destinatario = digits(addr.cep);
  }
  if (destinatario.telefone) {
    payload.telefone_destinatario = digits(destinatario.telefone);
  }

  return payload;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

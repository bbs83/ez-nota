import { isValidEmail } from "../validation/br-documents";
import type { EmitInvoiceInput } from "./types";

// Builds the Focus NFe v2 request body from our engine-agnostic EmitInvoiceInput.
// This is the ONLY module (besides focus-nfe.adapter) that knows Focus's wire
// format — field names verified against https://doc.focusnfe.com.br/reference/emitir_nfe
// (do not invent fields).
//
// ⚠️ PREMISSAS FISCAIS A VALIDAR COM CONTADOR (CLAUDE.md: FLAG, não assuma):
//  - CSOSN vs CST: para Simples Nacional o código vai em `icms_situacao_tributaria`
//    (sobrecarregado: CST no Regime Normal, CSOSN no Simples). Confirmar com contador.
//  - PIS/COFINS `*_situacao_tributaria`: "49" (Outras Operações) como premissa para Simples.
//  - modalidade_frete e quem paga o frete: premissa "0" (por conta do remetente/CIF)
//    quando há frete; revisar (FOB/destinatário pode ser 1).
//  - presenca_comprador=2 (não presencial/internet); finalidade=1 (normal); tipo=1 (saída).
//  - data_emissao em America/Sao_Paulo (-03:00, sem horário de verão desde 2019).

/** CRT (Código de Regime Tributário) por RegimeTributario. */
const CRT_BY_REGIME: Record<string, number> = {
  SIMPLES_NACIONAL: 1,
  SIMPLES_EXCESSO_SUBLIMITE: 2,
  REGIME_NORMAL: 3,
  SIMPLES_NACIONAL_MEI: 4,
};

/** local_destino: 1 = interna, 2 = interestadual, 3 = exterior. */
const LOCAL_DESTINO: Record<EmitInvoiceInput["destinoOperacao"], number> = {
  INTERNA: 1,
  INTERESTADUAL: 2,
  EXTERIOR: 3,
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
  email_destinatario?: string;
  valor_produtos: number;
  valor_frete: number;
  valor_desconto: number;
  valor_total: number;
  items: FocusNfeItem[];
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * data_emissao no fuso de São Paulo (-03:00). O Brasil não tem horário de verão
 * desde 2019, então o offset é fixo -03:00. FLAG: revisar se houver mudança de regra.
 */
function saoPauloIso(now: Date): string {
  const sp = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}` +
    `T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`
  );
}

export function buildFocusNfePayload(input: EmitInvoiceInput): FocusNfePayload {
  const { emitente, destinatario } = input;
  const crt = CRT_BY_REGIME[emitente.regimeTributario] ?? 1; // FLAG: default Simples
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
    valor_bruto: round2(item.valorTotal),
    inclui_no_total: 1,
    icms_origem: item.origem,
    // FLAG: Simples → CSOSN aqui; Regime Normal → CST.
    icms_situacao_tributaria: item.csosn ?? item.cst ?? "",
    // FLAG: premissa para Simples — validar com contador.
    pis_situacao_tributaria: "49",
    cofins_situacao_tributaria: "49",
  }));

  // FLAG: modalidade do frete + quem paga é premissa contábil.
  const modalidadeFrete = input.valorFrete > 0 ? 0 : 9;

  const payload: FocusNfePayload = {
    natureza_operacao: input.naturezaOperacao,
    data_emissao: saoPauloIso(new Date()),
    tipo_documento: 1, // 1 = saída. FLAG
    finalidade_emissao: 1, // 1 = normal. FLAG
    consumidor_final: 1, // venda a consumidor final. FLAG
    presenca_comprador: 2, // 2 = não presencial (internet). FLAG
    modalidade_frete: modalidadeFrete,
    local_destino: LOCAL_DESTINO[input.destinoOperacao],
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
    // 9 = não contribuinte (consumidor final PF). FLAG: muda se for contribuinte (CNPJ c/ IE).
    indicador_inscricao_estadual_destinatario: 9,
    valor_produtos: round2(input.valorProdutos),
    valor_frete: round2(input.valorFrete),
    valor_desconto: round2(input.valorDesconto),
    valor_total: round2(input.valorTotal),
    items,
  };

  if (cpfCnpj.length === 11) payload.cpf_destinatario = cpfCnpj;
  else if (cpfCnpj.length === 14) payload.cnpj_destinatario = cpfCnpj;

  const addr = destinatario.endereco;
  if (addr) {
    // FLAG: Shopify não separa número/bairro; bairro/município/IBGE vêm do ViaCEP
    // (best-effort) e o número fica "S/N" até o módulo de correção de endereço.
    // Focus deriva o código IBGE do município a partir de município+UF.
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
  // Preencher email_destinatario faz o Focus enviar XML+DANFE ao cliente por email
  // (campos.focusnfe.com.br: "o destinatário receberá um e-mail com o XML e a DANFE").
  // Campo até 60 chars; opcional — omitir se ausente/inválido não quebra a emissão.
  if (
    destinatario.email &&
    isValidEmail(destinatario.email) &&
    destinatario.email.length <= 60
  ) {
    payload.email_destinatario = destinatario.email;
  }

  return payload;
}

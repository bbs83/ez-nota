// Domain-level contract for any fiscal engine (Focus NFe, PlugNotas, NFE.io...).
// Route handlers and the emission flow depend ONLY on these types, never on a
// concrete engine's wire format — see CLAUDE.md decision #1 + the L3 TODO
// ("trocar engine sem refactor"). The Focus-specific JSON lives entirely inside
// focus-nfe.adapter.ts / nfe-payload.ts and never escapes the adapter.

// --- registerCompany ------------------------------------------------------

/** Company data forwarded to the engine when registering an "empresa". */
export interface RegisterCompanyInput {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  inscricaoEstadual: string;
  inscricaoMunicipal?: string | null;
  /** RegimeTributario enum value, e.g. "SIMPLES_NACIONAL". */
  regimeTributario: string;
  endereco: EmissionAddress;
  telefone?: string | null;
  email?: string | null;
  /** Ambiente enum value: "HOMOLOGACAO" | "PRODUCAO". */
  ambiente: string;
}

export interface RegisterCompanyResult {
  /** Opaque reference to the "empresa" created/held at the engine. */
  companyRef: string;
}

// --- shared value objects -------------------------------------------------

export interface EmissionAddress {
  logradouro: string;
  numero: string;
  complemento?: string | null;
  bairro: string;
  codigoMunicipioIbge: string;
  municipio: string;
  uf: string;
  cep: string;
}

export interface EmissionEmitente {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  inscricaoEstadual: string;
  /** Our RegimeTributario enum value; the adapter maps it to the engine's CRT. */
  regimeTributario: string;
  endereco: EmissionAddress;
}

export interface EmissionDestinatario {
  nome: string;
  /** CPF (11) or CNPJ (14) digits; null = consumidor final não identificado. */
  cpfCnpj?: string | null;
  email?: string | null;
  telefone?: string | null;
  endereco?: EmissionAddress | null;
}

export interface EmissionItem {
  /** Product/variant code (SKU or Shopify id). */
  codigo: string;
  descricao: string;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
  /** Commercial unit, e.g. "UN". */
  unidade: string;
  ncm: string;
  cfop: string;
  /** Simples Nacional (CRT 1/2/4). */
  csosn?: string | null;
  /** Regime Normal (CRT 3) — future. */
  cst?: string | null;
  /** Origem da mercadoria "0".."8". */
  origem: string;
}

// --- emitInvoice / cancelInvoice / getInvoiceStatus -----------------------

export interface EmitInvoiceInput {
  /** Ambiente enum value: "HOMOLOGACAO" | "PRODUCAO". */
  ambiente: string;
  /** TipoDocumento enum value: "NFE" | "NFCE". */
  tipoDocumento: string;
  serie: number;
  numero: number;
  naturezaOperacao: string;
  /** Operation scope (drives CFOP prefix + local_destino). */
  destinoOperacao: "INTERNA" | "INTERESTADUAL" | "EXTERIOR";
  emitente: EmissionEmitente;
  destinatario: EmissionDestinatario;
  itens: EmissionItem[];
  valorProdutos: number;
  valorFrete: number;
  valorDesconto: number;
  valorTotal: number;
  /** Stable key (per shop+order) so the engine call can be made idempotent. */
  idempotencyKey: string;
}

/**
 * Engine-agnostic emission status. The caller maps this to InvoiceStatus.
 * DENEGADO (SEFAZ denial — irregularidade fiscal) is kept distinct from REJECTED
 * at the engine boundary; the Prisma InvoiceStatus has no DENEGADO, so the caller
 * folds it into REJECTED for persistence (see TO_INVOICE_STATUS).
 */
export type EmissionStatus =
  | "AUTHORIZED"
  | "PROCESSING"
  | "REJECTED"
  | "DENEGADO"
  | "CANCELLED"
  | "ERROR";

export interface EmitInvoiceResult {
  status: EmissionStatus;
  /** Engine reference for later lookups/cancel (Focus "ref"). */
  engineRef: string | null;
  chaveAcesso: string | null;
  numero: number | null;
  serie: number | null;
  protocolo: string | null;
  xmlUrl: string | null;
  danfeUrl: string | null;
  /** SEFAZ status code (e.g. "100") + message. */
  sefazStatus: string | null;
  sefazMessage: string | null;
  rejectionCode: string | null;
  /** Engine request/response, opaque to the rest of the app — for audit/persist. */
  rawRequest: unknown;
  rawResponse: unknown;
}

export interface CancelInvoiceInput {
  engineRef: string;
  /** Justificativa do cancelamento na SEFAZ (15–255 chars). */
  justificativa: string;
}

/** Desfecho normalizado de um pedido de cancelamento na SEFAZ. */
export type CancelStatus =
  | "cancelado" // evento de cancelamento homologado pela SEFAZ
  | "recusado" // SEFAZ recusou (ex.: prazo expirado, nota não autorizada)
  | "erro"; // falha técnica/transitória ao processar o cancelamento

export interface CancelInvoiceResult {
  status: CancelStatus;
  /** Protocolo do evento de cancelamento, quando homologado. */
  protocoloCancelamento: string | null;
  /** Código de status SEFAZ (ex.: "135" homologado, "501" prazo expirado). */
  sefazStatus: string | null;
  sefazMessage: string | null;
  rawResponse: unknown;
}

/**
 * Result of polling the engine for a document's terminal state (by engineRef).
 * AUTHORIZED carries chave/numero/serie/protocolo + xml/danfe links; REJECTED/
 * DENEGADO carry sefazStatus + sefazMessage + rejectionCode. Fields not relevant
 * to the current status are null. Mirrors EmitInvoiceResult (minus engineRef/
 * rawRequest) so the caller persists it with the same mapping.
 */
export interface InvoiceStatusResult {
  status: EmissionStatus;
  chaveAcesso: string | null;
  numero: number | null;
  serie: number | null;
  protocolo: string | null;
  xmlUrl: string | null;
  danfeUrl: string | null;
  /** SEFAZ status code (e.g. "100" authorized, "302" denied) + message. */
  sefazStatus: string | null;
  sefazMessage: string | null;
  rejectionCode: string | null;
  rawResponse: unknown;
}

export interface FiscalEngineAdapter {
  /**
   * Registers the merchant's company at the engine, forwarding the A1 certificate.
   * The .pfx bytes and password are passed through here and held by the engine —
   * EZ Nota NEVER persists them (CLAUDE.md decision #2).
   */
  registerCompany(
    emitente: RegisterCompanyInput,
    certPfx: Buffer,
    certPassword: string,
  ): Promise<RegisterCompanyResult>;

  /**
   * Submits the NF-e to the engine. ASYNCHRONOUS by contract: the engine queues
   * the document at SEFAZ and returns PROCESSING + an engineRef (never a terminal
   * AUTHORIZED). The terminal state (autorizado/rejeitado/denegado) is obtained
   * later via getInvoiceStatus(engineRef). The caller persists the Invoice in
   * PROCESSING and polls. (Focus may occasionally answer synchronously, but the
   * contract assumes async — see CLAUDE.md M1.)
   */
  emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceResult>;
  cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult>;
  /** Polls the engine for the document's current/terminal state by its engineRef. */
  getInvoiceStatus(engineRef: string): Promise<InvoiceStatusResult>;
}

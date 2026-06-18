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
  emitente: EmissionEmitente;
  destinatario: EmissionDestinatario;
  itens: EmissionItem[];
  valorProdutos: number;
  valorTotal: number;
  /** Stable key (per shop+order) so the engine call can be made idempotent. */
  idempotencyKey: string;
}

/** Engine-agnostic emission status. The caller maps this to InvoiceStatus. */
export type EmissionStatus =
  | "AUTHORIZED"
  | "PROCESSING"
  | "REJECTED"
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
  justificativa: string;
}
export interface CancelInvoiceResult {
  status: EmissionStatus;
  sefazMessage: string | null;
  rawResponse: unknown;
}

export interface InvoiceStatusResult {
  status: EmissionStatus;
  chaveAcesso: string | null;
  xmlUrl: string | null;
  danfeUrl: string | null;
  sefazMessage: string | null;
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

  emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceResult>;
  cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult>;
  getInvoiceStatus(engineRef: string): Promise<InvoiceStatusResult>;
}

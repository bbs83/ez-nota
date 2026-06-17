// Domain-level contract for any fiscal engine (Focus NFe, PlugNotas, NFE.io...).
// Route handlers and the onboarding flow depend ONLY on this interface, never on a
// concrete engine — see CLAUDE.md decision #1 (fiscal-engine ADAPTER layer).

/** Company data forwarded to the engine when registering an "empresa". */
export interface RegisterCompanyInput {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  inscricaoEstadual: string;
  inscricaoMunicipal?: string | null;
  /** RegimeTributario enum value, e.g. "SIMPLES_NACIONAL". */
  regimeTributario: string;
  endereco: {
    logradouro: string;
    numero: string;
    complemento?: string | null;
    bairro: string;
    codigoMunicipioIbge: string;
    municipio: string;
    uf: string;
    cep: string;
  };
  telefone?: string | null;
  email?: string | null;
  /** Ambiente enum value: "HOMOLOGACAO" | "PRODUCAO". */
  ambiente: string;
}

export interface RegisterCompanyResult {
  /** Opaque reference to the "empresa" created/held at the engine. */
  companyRef: string;
}

// The invoice-lifecycle methods are part of the contract but not yet exercised —
// the fiscal core (MVP step 4) will flesh these payloads out.
export interface EmitInvoiceInput {
  /** TODO(fiscal-core): full NF-e payload (items, NCM/CFOP/CSOSN, totals...). */
  companyRef: string;
  idempotencyKey: string;
}
export interface EmitInvoiceResult {
  /** TODO(fiscal-core): chave de acesso, protocolo, status, XML/DANFE urls. */
  engineRef: string;
}
export interface CancelInvoiceInput {
  engineRef: string;
  justificativa: string;
}
export interface CancelInvoiceResult {
  cancelled: boolean;
}
export interface InvoiceStatusResult {
  /** Engine-reported status; mapped to InvoiceStatus by the caller. */
  status: string;
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

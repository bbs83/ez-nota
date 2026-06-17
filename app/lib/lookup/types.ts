// Shared result shapes for the external lookups. Kept free of any server-only code
// so both the *.server lookups and the client wizard can import these types.

export interface CnpjLookupResult {
  razaoSocial: string;
  nomeFantasia: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  codigoMunicipioIbge: string;
  telefone: string;
  email: string;
}

export interface CepLookupResult {
  logradouro: string;
  bairro: string;
  municipio: string;
  uf: string;
  codigoMunicipioIbge: string;
}

/** Discriminated envelope returned by the lookup resource routes. */
export type LookupResponse<T> =
  | { ok: true; reason: null; data: T }
  | { ok: false; reason: "invalid" | "not_found" | "error"; data: null };

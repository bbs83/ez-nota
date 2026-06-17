import { onlyDigits } from "../validation/br-documents";
import type { CnpjLookupResult } from "./types";

const BASE = "https://brasilapi.com.br/api/cnpj/v1";

/**
 * Looks up a CNPJ on BrasilAPI and maps it to our address/identity shape.
 * Returns null when the CNPJ is malformed or not found; throws on network error
 * so the caller can distinguish "not found" from "lookup unavailable".
 */
export async function lookupCnpj(cnpj: string): Promise<CnpjLookupResult | null> {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return null;

  const res = await fetch(`${BASE}/${digits}`, {
    headers: { "User-Agent": "EZNota/1.0", Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`BrasilAPI returned ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const str = (key: string): string => {
    const v = data[key];
    return v === null || v === undefined ? "" : String(v);
  };

  return {
    razaoSocial: str("razao_social"),
    nomeFantasia: str("nome_fantasia"),
    logradouro: str("logradouro"),
    numero: str("numero"),
    complemento: str("complemento"),
    bairro: str("bairro"),
    municipio: str("municipio"),
    uf: str("uf"),
    cep: onlyDigits(str("cep")),
    codigoMunicipioIbge: str("codigo_municipio_ibge"),
    telefone: str("ddd_telefone_1"),
    email: str("email"),
  };
}

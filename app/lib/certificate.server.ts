// Best-effort extraction of A1 certificate metadata (subject CNPJ + validity).
//
// Parsing a PKCS#12 (.pfx/.p12) requires a dedicated parser (e.g. node-forge), which
// is a non-trivial dependency we haven't signed off on yet (CLAUDE.md: ask before
// adding heavy deps). Until then this returns nulls — the spec allows leaving
// validTo null for now. The bytes passed in are NEVER persisted here.

export interface CertificateMetadata {
  subjectCnpj: string | null;
  validFrom: Date | null;
  validTo: Date | null;
}

export async function extractCertificateMetadata(
  _pfx: Buffer,
  _password: string,
): Promise<CertificateMetadata> {
  // TODO(cert): parse PKCS#12 to read the subject CNPJ and notAfter/notBefore.
  return { subjectCnpj: null, validFrom: null, validTo: null };
}

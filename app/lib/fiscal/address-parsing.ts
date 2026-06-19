// Extrai o NÚMERO do logradouro a partir do address1 do Shopify.
//
// Por quê: Shopify não separa número/bairro nem expõe campo estruturado de número
// para o Brasil (confirmado no Dev MCP: MailingAddress só tem address1/address2;
// LocalizedFieldKey BR é só TAX_CREDENTIAL_BR/SHIPPING_CREDENTIAL_BR). Então o
// "Avenida Piassanguaba, 80" vinha inteiro no logradouro e o número caía em "S/N".
//
// Função PURA (sem I/O) e CONSERVADORA: na dúvida NÃO corrompe o logradouro —
// mantém o logradouro completo e número "S/N". É uma heurística de melhor-esforço
// e o XML autoritativo é o do Focus.
//
// ⚠️ FLAG (CLAUDE.md): heurística de endereço — casos ambíguos preferem "S/N".

export interface ParsedLogradouro {
  /** Logradouro sem o número (quando extraído com confiança). */
  logradouro: string;
  /** Dígitos (com letra opcional, ex. "123A") ou "S/N" quando não identificável. */
  numero: string;
  /** Texto sobrando após o número (ex. "fundos"), ou null. */
  complemento: string | null;
}

const SN = "S/N";

// "s/n", "sn", "s/nº", "s/no", "s.n.", "sem número/numero" — segmento inteiro.
const SN_TOKEN_RE = /^(s\s*[./]?\s*n[ºo°]?\.?|sem\s*n[uú]mero)$/i;

function isSnToken(s: string): boolean {
  return SN_TOKEN_RE.test(s.trim());
}

/**
 * De um segmento que DEVERIA começar com o número ("80", "123A", "123-A",
 * "123, fundos", "123 fundos") extrai número + complemento sobrando.
 * Retorna null se o segmento não começa por dígito.
 * A letra do número só conta se estiver colada (evita comer a 1ª letra de uma
 * palavra: "123 fundos" → número "123", não "123f").
 */
function takeLeadingNumero(
  segment: string,
): { numero: string; complemento: string } | null {
  const m = segment.match(/^\s*(\d+)(-?[A-Za-z])?(?=$|[\s,])/);
  if (!m) return null;
  const numero = (m[1] + (m[2] ?? "")).replace(/-/g, ""); // "123-A" → "123A"
  const complemento = segment.slice(m[0].length).replace(/^[\s,]+/, "").trim();
  return { numero, complemento };
}

export function parseEnderecoLogradouro(
  address1: string | null | undefined,
): ParsedLogradouro {
  const raw = (address1 ?? "").trim();
  if (!raw) return { logradouro: "", numero: SN, complemento: null };
  if (isSnToken(raw)) return { logradouro: "", numero: SN, complemento: null };

  // ── Caminho 1: tem vírgula — o número (ou s/n) vem APÓS a 1ª vírgula.
  // É o sinal mais forte; "Rua 7 de Setembro, 100" → número "100" (não "7").
  const commaIdx = raw.indexOf(",");
  if (commaIdx >= 0) {
    const head = raw.slice(0, commaIdx).trim(); // logradouro
    const tail = raw.slice(commaIdx + 1).trim(); // "número[, complemento]"
    const firstTailPart = tail.split(",")[0].trim();

    if (isSnToken(firstTailPart)) {
      const after = tail.includes(",")
        ? tail.slice(tail.indexOf(",") + 1).trim()
        : "";
      return { logradouro: head, numero: SN, complemento: after || null };
    }

    const taken = takeLeadingNumero(tail);
    if (taken && head) {
      return {
        logradouro: head,
        numero: taken.numero,
        complemento: taken.complemento || null,
      };
    }
    // Vírgula sem número identificável → não corromper: logradouro inteiro, S/N.
    return { logradouro: raw, numero: SN, complemento: null };
  }

  // ── Caminho 2: sem vírgula — número no FINAL, só se o logradouro tiver ≥2
  // palavras. Pega "Avenida Piassanguaba 80" → "80", mas evita "Rua 7"
  // (rua nomeada por número, sem número de porta) virar número "7".
  const endNum = raw.match(/^(.*\S)\s+(\d+(?:-?[A-Za-z])?)$/);
  if (endNum) {
    const head = endNum[1].trim();
    if (head.split(/\s+/).length >= 2) {
      return {
        logradouro: head,
        numero: endNum[2].replace(/-/g, ""),
        complemento: null,
      };
    }
  }

  // ── s/n explícito no fim, sem vírgula: "Rua X s/n".
  const endSn = raw.match(/^(.*\S)\s+(s\s*[./]?\s*n[ºo°]?\.?)$/i);
  if (endSn) {
    return { logradouro: endSn[1].trim(), numero: SN, complemento: null };
  }

  // ── Sem número identificável → comportamento seguro (atual).
  return { logradouro: raw, numero: SN, complemento: null };
}

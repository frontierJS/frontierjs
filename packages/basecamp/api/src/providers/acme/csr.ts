// src/providers/acme/csr.ts
// A PKCS#10 certificate request (RFC 2986) built by hand, because the ACME
// client has no dependency to build one with (`FJS-D1973`).
//
// Only what a CA asks of a TLS request is encoded: an EC P-256 key, a subject
// of one common name, and the names in a subjectAltName extension. Let's Encrypt
// reads the names from the extension and ignores the subject, so the subject is
// there for the CAs that still print it.
//
// The one trap is the signature. WebCrypto's ECDSA returns raw `r || s`, which
// is the form a JWS wants and is NOT the form X.509 wants — a CSR carries
// `SEQUENCE { INTEGER r, INTEGER s }`. A request signed with the raw form parses
// and then fails verification with a message that names neither.

const encoder = new TextEncoder()

/** One DER element: tag, length, content. */
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0)
  // DER lengths: short form under 128, else a count of length bytes then the
  // length. A request is well under 64 KiB, so two bytes is the ceiling.
  const head = length < 0x80   ? [tag, length]
             : length < 0x100  ? [tag, 0x81, length]
             :                   [tag, 0x82, length >> 8, length & 0xff]
  const out = new Uint8Array(head.length + length)
  out.set(head)
  let at = head.length
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const seq    = (...parts: Uint8Array[]) => tlv(0x30, ...parts)
const set    = (...parts: Uint8Array[]) => tlv(0x31, ...parts)
const octets = (...parts: Uint8Array[]) => tlv(0x04, ...parts)
const utf8   = (text: string)           => tlv(0x0c, encoder.encode(text))

/** `[2]` IMPLICIT IA5String — a dNSName inside a GeneralName. */
const dnsName = (text: string) => tlv(0x82, encoder.encode(text))

/** BIT STRING with no unused bits. */
const bits = (body: Uint8Array) => tlv(0x03, new Uint8Array([0]), body)

/** OBJECT IDENTIFIER from dotted form: the first two arcs share a byte, the
 *  rest are base-128 with the high bit marking "more". */
function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number)
  const bytes: number[] = [arcs[0] * 40 + arcs[1]]
  for (const arc of arcs.slice(2)) {
    const groups = [arc & 0x7f]
    for (let rest = arc >> 7; rest > 0; rest >>= 7) groups.unshift((rest & 0x7f) | 0x80)
    bytes.push(...groups)
  }
  return tlv(0x06, new Uint8Array(bytes))
}

/** INTEGER from big-endian unsigned bytes: leading zeros dropped, one put back
 *  when the high bit is set — otherwise the number reads as negative. */
function integer(unsigned: Uint8Array): Uint8Array {
  let start = 0
  while (start < unsigned.length - 1 && unsigned[start] === 0) start++
  const body = unsigned.slice(start)
  return tlv(0x02, body[0] & 0x80 ? new Uint8Array([0, ...body]) : body)
}

/** WebCrypto's `r || s` into DER `SEQUENCE { INTEGER r, INTEGER s }`. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  return seq(integer(raw.slice(0, half)), integer(raw.slice(half)))
}

const OID_COMMON_NAME       = '2.5.4.3'
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14'
const OID_SUBJECT_ALT_NAME  = '2.5.29.17'
const OID_ECDSA_SHA256      = '1.2.840.10045.4.3.2'

/**
 * The DER of a certificate request for `names`, signed by `keys`.
 *
 * `names` may hold `*.example.test`; the request carries it verbatim as a
 * dNSName, which is how a CA reads a wildcard.
 */
export async function buildCsr(names: string[], keys: CryptoKeyPair): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))

  // A common name is capped at 64 characters (RFC 5280); a longer first name
  // would make a request the CA refuses, and the names are in the extension.
  const subject = names[0].length <= 64
    ? seq(set(seq(oid(OID_COMMON_NAME), utf8(names[0]))))
    : seq()

  const altNames   = seq(...names.map(dnsName))
  const extensions = seq(seq(oid(OID_SUBJECT_ALT_NAME), octets(altNames)))
  const attributes = tlv(0xa0, seq(oid(OID_EXTENSION_REQUEST), set(extensions)))

  const info = seq(integer(new Uint8Array([0])), subject, spki, attributes)
  const raw  = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new Uint8Array(info)))

  return seq(info, seq(oid(OID_ECDSA_SHA256)), bits(ecdsaRawToDer(raw)))
}

/** PEM armor, 64 columns. */
export function toPem(label: string, der: Uint8Array): string {
  const base64 = Buffer.from(der).toString('base64')
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`
}

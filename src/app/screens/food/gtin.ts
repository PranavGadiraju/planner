// Pure GTIN helpers for the scanner, kept apart from scan.ts (which imports the wasm reader) so vitest covers them:
// UPC-E -> UPC-A expansion and "which code do we look up" for a decoder hit or typed digits.
import { validGtin } from '@shared/nutrition'

/** The GS1 check digit for a code body (weights 3,1,3,... from the right), the same rule validGtin verifies. */
function checkDigit(body: string): string {
  let sum = 0
  body.split('').map(Number).reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1) })
  return String((10 - (sum % 10)) % 10)
}

/**
 * UPC-E (8 digits: number system 0/1, six data digits, then the check digit of the *expanded* code; or just the six
 * data digits) -> the 12-digit UPC-A it compresses, which is how Open Food Facts and USDA key the product and what
 * validGtin checks. The last data digit says where the zeros were squeezed out. Anything else comes back unchanged.
 */
export function expandUpcE(code: string): string {
  const digits = code.replace(/\D/g, '')
  let ns = '0'
  let data: string
  let check: string | null = null
  if (digits.length === 8) {
    ns = digits.charAt(0)
    data = digits.slice(1, 7)
    check = digits.charAt(7)
  } else if (digits.length === 6) {
    data = digits
  } else {
    return code
  }
  if (ns !== '0' && ns !== '1') return code
  const [a, b, c, d, e, f] = data.split('') as [string, string, string, string, string, string]
  let body: string
  if (f === '0' || f === '1' || f === '2') body = `${a}${b}${f}0000${c}${d}${e}`
  else if (f === '3') body = `${a}${b}${c}00000${d}${e}`
  else if (f === '4') body = `${a}${b}${c}${d}00000${e}`
  else body = `${a}${b}${c}${d}${e}0000${f}`
  const upcA = `${ns}${body}`
  return upcA + (check ?? checkDigit(upcA))
}

/** The GTIN a detector hit stands for: a UPC-E hit is expanded, every other EAN/UPC format is its raw value. */
export function scannedGtin(format: string, rawValue: string): string {
  return format === 'upc_e' ? expandUpcE(rawValue) : rawValue
}

/**
 * The code to look up for scanned or typed digits: the digits themselves when their check digit holds; else, for eight
 * digits that fail as EAN-8, their UPC-E expansion when that one holds (a typed UPC-E). Null when neither checks out.
 */
export function resolveGtin(code: string): string | null {
  const digits = code.replace(/\D/g, '')
  if (validGtin(digits)) return digits
  if (digits.length === 8) {
    const upcA = expandUpcE(digits)
    if (upcA !== digits && validGtin(upcA)) return upcA
  }
  return null
}

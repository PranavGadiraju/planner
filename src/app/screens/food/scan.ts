// Still-photo barcode decoding with the barcode-detector ponyfill (zxing-wasm). Loaded lazily by the Scan panel only,
// and the .wasm is a self-hosted Vite asset (precached by the service worker) so scanning works with no signal.
// Never getUserMedia: the photo comes from <input type=file capture=environment>.
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
})

export const SCAN_FORMATS = ['ean_13', 'upc_a', 'ean_8', 'upc_e'] as const

let detector: BarcodeDetector | null = null
function getDetector(): BarcodeDetector {
  detector ??= new BarcodeDetector({ formats: [...SCAN_FORMATS] })
  return detector
}

function scaled(bitmap: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const f = maxSide / Math.max(bitmap.width, bitmap.height)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bitmap.width * f))
  c.height = Math.max(1, Math.round(bitmap.height * f))
  const ctx = c.getContext('2d')
  if (ctx) ctx.drawImage(bitmap, 0, 0, c.width, c.height)
  return c
}

/**
 * The first EAN/UPC value found in a photo, or null. A downscaled copy is tried first (fast, and phone photos are
 * 12 MP), then the full-resolution image for small or distant codes.
 */
export async function decodeBarcode(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const sizes = [...new Set([Math.min(1400, longest), Math.min(2400, longest), longest])]
    for (const size of sizes) {
      const source: ImageBitmap | HTMLCanvasElement = size === longest ? bitmap : scaled(bitmap, size)
      const found = await getDetector().detect(source)
      const hit = found.find((b) => /^\d{8,14}$/.test(b.rawValue))
      if (hit) return hit.rawValue
    }
    return null
  } finally {
    bitmap.close()
  }
}

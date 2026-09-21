/**
 * An image's pixel size, read from its header.
 *
 * The alternative is to decode the image, and the whole point is not to: a vault of 20,000
 * originals is read once to learn 20,000 proportions, and a decode of each would cost minutes
 * of work for two numbers that sit in the first few dozen bytes. A format this cannot read
 * returns null and the image keeps a square cell.
 */
export interface PixelSize {width: number; height: number}

export function readImageSize(data: ArrayBuffer | Uint8Array): PixelSize | null {
 const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
 return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? bmp(bytes);
}

const ascii = (bytes: Uint8Array, at: number, text: string) => text.split('').every((char, index) => bytes[at + index] === char.charCodeAt(0));
const be16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const be32 = (bytes: Uint8Array, at: number) => (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
const le16 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const le24 = (bytes: Uint8Array, at: number) => le16(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const le32 = (bytes: Uint8Array, at: number) => (le16(bytes, at) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
const size = (width: number, height: number): PixelSize | null => width > 0 && height > 0 ? {width, height} : null;

function png(bytes: Uint8Array): PixelSize | null {
 if (bytes.length < 24 || bytes[0] !== 0x89 || !ascii(bytes, 1, 'PNG')) return null;
 return size(be32(bytes, 16), be32(bytes, 20));
}

/** Walk the segments to the frame header; comments and colour profiles come before it. */
function jpeg(bytes: Uint8Array): PixelSize | null {
 if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
 for (let at = 2; at + 9 < bytes.length;) {
  if (bytes[at] !== 0xff) return null;
  const marker = bytes[at + 1] ?? 0;
  if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
  if (marker === 0xd9 || marker === 0xda) return null;
  const length = be16(bytes, at + 2);
  if (length < 2) return null;
  // Every SOF but the four that carry no size: DHT (c4), DAC (cc) and the restarts.
  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(be16(bytes, at + 7), be16(bytes, at + 5));
  at += 2 + length;
 }
 return null;
}

function gif(bytes: Uint8Array): PixelSize | null {
 if (bytes.length < 10 || !ascii(bytes, 0, 'GIF8')) return null;
 return size(le16(bytes, 6), le16(bytes, 8));
}

function webp(bytes: Uint8Array): PixelSize | null {
 if (bytes.length < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null;
 if (ascii(bytes, 12, 'VP8X')) return size(le24(bytes, 24) + 1, le24(bytes, 27) + 1);
 if (ascii(bytes, 12, 'VP8L')) { const packed = le32(bytes, 21); return size((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1); }
 if (ascii(bytes, 12, 'VP8 ')) return size(le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff);
 return null;
}

function bmp(bytes: Uint8Array): PixelSize | null {
 if (bytes.length < 26 || !ascii(bytes, 0, 'BM')) return null;
 // A negative height means the rows are stored top-down. The picture is the same size.
 return size(Math.abs(le32(bytes, 18) | 0), Math.abs(le32(bytes, 22) | 0));
}

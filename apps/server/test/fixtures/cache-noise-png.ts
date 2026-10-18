import { deflateSync } from 'node:zlib';

export function noisePng() {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Buffer) => {
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4),
      data = Buffer.concat([Buffer.from(type), bytes]);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc(data));
    return Buffer.concat([size, data, checksum]);
  };
  const width = 32,
    height = 96,
    raw = Buffer.alloc(height * (width * 4 + 1));
  let seed = 123456789;
  for (let y = 0; y < height; y++)
    for (let x = 1; x <= width * 4; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw[y * (width * 4 + 1) + x] = seed & 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

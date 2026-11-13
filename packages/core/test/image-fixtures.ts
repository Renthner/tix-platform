import sharp from 'sharp';

/** A real, decodable solid-colour PNG; `salt` makes the bytes (and thus the sha256) unique. */
export async function solidPng(width: number, height: number, salt = 0): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: salt % 256, g: Math.floor(salt / 256) % 256, b: 7 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

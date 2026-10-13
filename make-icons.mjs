/**
 * 生成 App 图标（纯手写 PNG，不依赖任何库）。
 *
 *   node make-icons.mjs
 *
 * 图案：深色底 + 金色圆环 + 中心一点 —— 像个印章，也像"记录"的圈。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

function crc32(buf) {
  let c;
  const t = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}

function makeIcon(size) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.33;
  const ringW = size * 0.055;
  const dotR = size * 0.095;

  // 颜色
  const bg = [17, 17, 16];
  const gold = [201, 162, 39];

  for (let y = 0; y < size; y++) {
    const o = y * (1 + size * 3);
    raw[o] = 0; // filter
    for (let x = 0; x < size; x++) {
      const p = o + 1 + x * 3;
      const d = Math.hypot(x - cx, y - cy);

      // 抗锯齿：按到边界的距离做一点渐变
      const inRing = Math.abs(d - ringR) < ringW / 2;
      const inDot = d < dotR;

      let col = bg;
      if (inRing || inDot) col = gold;
      else {
        // 环边缘一像素的柔化
        const edge = Math.min(Math.abs(d - ringR) - ringW / 2, d - dotR);
        if (edge > 0 && edge < 1.2) {
          const t = 1 - edge / 1.2;
          col = bg.map((v, i) => Math.round(v + (gold[i] - v) * t));
        }
      }
      raw[p] = col[0];
      raw[p + 1] = col[1];
      raw[p + 2] = col[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const buf = makeIcon(size);
  fs.writeFileSync(`icon-${size}.png`, buf);
  console.log(`icon-${size}.png  ${buf.length} 字节`);
}

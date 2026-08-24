import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/icons");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const body = Buffer.concat([typeBytes, data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function drawIcon(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const nodes = [
    [0.28, 0.32], [0.69, 0.27], [0.5, 0.53], [0.26, 0.72], [0.73, 0.72],
  ];
  const lines = [[0, 2], [1, 2], [2, 3], [2, 4], [3, 4]];
  const distanceToSegment = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const radius = 0.16;
      const cornerDistance = Math.hypot(Math.max(Math.abs(nx - 0.5) - (0.5 - radius), 0), Math.max(Math.abs(ny - 0.5) - (0.5 - radius), 0));
      const inside = cornerDistance <= radius;
      const offset = y * stride + 1 + x * 4;
      if (!inside) {
        raw[offset + 3] = 0;
        continue;
      }
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.28, ny - 0.18) * 1.45);
      let red = Math.round(7 + glow * 7);
      let green = Math.round(17 + glow * 54);
      let blue = Math.round(31 + glow * 72);
      for (const [a, b] of lines) {
        const [ax, ay] = nodes[a];
        const [bx, by] = nodes[b];
        if (distanceToSegment(nx, ny, ax, ay, bx, by) < 0.018) {
          red = 23; green = 170; blue = 190;
        }
      }
      for (const [cx, cy] of nodes) {
        if (Math.hypot(nx - cx, ny - cy) < 0.055) {
          red = 49; green = 209; blue = 160;
        }
      }
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

await mkdir(output, { recursive: true });
for (const size of [192, 512]) await writeFile(resolve(output, `icon-${size}.png`), drawIcon(size), { mode: 0o644 });

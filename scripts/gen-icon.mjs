/**
 * Generates icon.png (160x160) with zero dependencies:
 * a rounded-square indigo gradient tile with a white pencil drawn diagonally.
 * Run: node scripts/gen-icon.mjs
 */
import {deflateSync} from "node:zlib";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SIZE = 160;
const SS = 3; // supersampling factor
const W = SIZE * SS;

const buffer = new Float32Array(W * W * 4);

const lerp = (a, b, t) => a + (b - a) * t;

// SDF helpers -------------------------------------------------------------
const sdRoundRect = (px, py, cx, cy, hx, hy, r) => {
    const dx = Math.abs(px - cx) - (hx - r);
    const dy = Math.abs(py - cy) - (hy - r);
    const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
};

const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
const inTriangle = (p, a, b, c) => {
    const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
};

// pencil parts, in local space (pencil lies horizontally, tip to the right)
const halfH = 10.5;
const body = (x, y) => sdRoundRect(x, y, -8, 0, 47, halfH, 5) < 0;
const tip = (x, y) => inTriangle([x, y], [38, -halfH], [38, halfH], [66, 0]);
const lead = (x, y) => inTriangle([x, y], [56, -4.4], [56, 4.4], [66, 0]);
const eraser = (x, y) => sdRoundRect(x, y, -62, 0, 7.5, halfH, 6) < 0;
const ferrule = (x, y) => sdRoundRect(x, y, -50.5, 0, 2.6, halfH + 0.6, 2) < 0;

const COLORS = {
    bg1: [0x5b, 0x5f, 0xf1],   // indigo
    bg2: [0x8b, 0x5c, 0xf6],   // violet
    white: [0xff, 0xff, 0xff],
    wood: [0xf6, 0xc1, 0x6b],
    graphite: [0x37, 0x3a, 0x45],
    eraserCol: [0xfb, 0x8a, 0x8c],
    ferruleCol: [0xd9, 0xdc, 0xe4],
};

const cx = W / 2, cy = W / 2;
const COS = Math.cos(-Math.PI / 4), SIN = Math.sin(-Math.PI / 4);

for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
        // local (rotated -45deg, pencil points up-right)
        const dx = x - cx, dy = y - cy;
        const lx = (dx * COS - dy * SIN) / 1.22;
        const ly = (dx * SIN + dy * COS) / 1.22;

        let r = 0, g = 0, b = 0, a = 0;

        // rounded-square tile
        const tile = sdRoundRect(x, y, cx, cy, cx - 8 * SS, cy - 8 * SS, 34 * SS);
        if (tile < 0) {
            const t = (x + y) / (2 * W);
            r = lerp(COLORS.bg1[0], COLORS.bg2[0], t);
            g = lerp(COLORS.bg1[1], COLORS.bg2[1], t);
            b = lerp(COLORS.bg1[2], COLORS.bg2[2], t);
            a = 255;
        } else if (tile < 1.5 * SS) {
            // soften edge
            const t = (x + y) / (2 * W);
            const alpha = 1 - (tile / (1.5 * SS));
            r = lerp(COLORS.bg1[0], COLORS.bg2[0], t);
            g = lerp(COLORS.bg1[1], COLORS.bg2[1], t);
            b = lerp(COLORS.bg1[2], COLORS.bg2[2], t);
            a = 255 * alpha;
        }

        // pencil parts over the tile
        let col = null;
        if (lead(lx, ly)) col = COLORS.graphite;
        else if (tip(lx, ly)) col = COLORS.wood;
        else if (ferrule(lx, ly)) col = COLORS.ferruleCol;
        else if (eraser(lx, ly)) col = COLORS.eraserCol;
        else if (body(lx, ly)) col = COLORS.white;
        if (col) {
            r = col[0]; g = col[1]; b = col[2]; a = 255;
        }

        const i = (y * W + x) * 4;
        buffer[i] = r; buffer[i + 1] = g; buffer[i + 2] = b; buffer[i + 3] = a;
    }
}

// box downsample -----------------------------------------------------------
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
                r += buffer[i]; g += buffer[i + 1]; b += buffer[i + 2]; a += buffer[i + 3];
            }
        }
        const n = SS * SS;
        const o = (y * SIZE + x) * 4;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
}

// PNG encode ---------------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
]);

const outPath = join(fileURLToPath(new URL("..", import.meta.url)), "icon.png");
writeFileSync(outPath, png);
console.log(`icon.png written (${png.length} bytes)`);

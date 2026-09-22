// 生成 icon.png：渐变圆角底 + 白色隧道环 + 深蓝文件卡穿环而出（"文件隧道/穿透"）。
// 遮挡关系：环带最后覆盖，卡片在环带处被遮挡——呈现从洞中穿过的线程感。
// 零依赖：解析几何 + 4x 超采样抗锯齿 + zlib 手写 PNG 编码。
// 用法：node scripts/make-icon.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import {resolve} from "node:path";

const S = 512;   // 输出边长
const SS = 4;    // 每轴超采样倍数（16 样本/像素）

// ---------- 解析几何 ----------
const rr = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) {
        return false;
    }
    const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
    const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
    return dx * dx + dy * dy <= r * r;
};
const circ = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const tri = (x, y, ax, ay, bx, by, cx, cy) => {
    const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};

// ---------- 场景（512 坐标系，自下而上覆盖） ----------
const TOP = [74, 123, 245];    // #4A7BF5
const BOT = [41, 176, 232];    // #29B0E8
const NAVY = [23, 55, 112];    // #173770 文件卡
const grad = (x, y) => {
    const t = Math.min(1, Math.max(0, (x + y) / 1024));
    return [TOP[0] + (BOT[0] - TOP[0]) * t, TOP[1] + (BOT[1] - TOP[1]) * t, TOP[2] + (BOT[2] - TOP[2]) * t];
};

function shade(x, y) {
    if (!rr(x, y, 0, 0, S, S, 112)) {
        return null; // 圆角外透明
    }
    let col = grad(x, y);
    // 文件卡（左上角折角镂空透出底色）+ 右侧箭头，一体成箭形
    const fold = tri(x, y, 156, 210, 156, 236, 182, 210);
    if (!fold && (rr(x, y, 156, 210, 394, 302, 14) || tri(x, y, 394, 196, 394, 316, 454, 256))) {
        col = NAVY;
    }
    // 隧道环最后覆盖：卡片穿过右环带处被遮挡，卡身悬于洞中、箭头在外
    const d2 = (x - 216) ** 2 + (y - 256) ** 2;
    if (d2 <= 138 * 138 && d2 >= 94 * 94) {
        col = [255, 255, 255];
    }
    return col;
}

// ---------- 超采样 + 盒式滤波（预乘 alpha 平均） ----------
const px = Buffer.alloc(S * S * 4);
for (let py = 0; py < S; py++) {
    for (let pxi = 0; pxi < S; pxi++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < SS; j++) {
            for (let i = 0; i < SS; i++) {
                const c = shade(pxi + (i + 0.5) / SS, py + (j + 0.5) / SS);
                if (c) {
                    r += c[0];
                    g += c[1];
                    b += c[2];
                    a += 255;
                }
            }
        }
        const o = (py * S + pxi) * 4;
        if (a > 0) {
            px[o] = Math.round(r / (a / 255));
            px[o + 1] = Math.round(g / (a / 255));
            px[o + 2] = Math.round(b / (a / 255));
            px[o + 3] = Math.round(a / (SS * SS));
        }
    }
}

// ---------- PNG 编码（RGBA8，filter 0） ----------
const CRC_TABLE = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let row = 0; row < S; row++) {
    raw[row * (S * 4 + 1)] = 0; // filter: none
    px.copy(raw, row * (S * 4 + 1) + 1, row * S * 4, (row + 1) * S * 4);
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
]);
const out = resolve(import.meta.dirname, "../icon.png");
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${S}x${S}，${png.length} 字节）`);

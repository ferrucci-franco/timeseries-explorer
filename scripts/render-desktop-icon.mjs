import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const iconDir = path.join(root, 'build', 'icons');
const svgPath = path.join(iconDir, 'timeseries-explorer-icon.svg');
const pngPath = path.join(iconDir, 'timeseries-explorer-icon.png');
const icoPath = path.join(iconDir, 'timeseries-explorer-icon.ico');

function icoFromPng(pngBuffer) {
    const headerSize = 6;
    const entrySize = 16;
    const offset = headerSize + entrySize;
    const buffer = Buffer.alloc(offset + pngBuffer.length);
    buffer.writeUInt16LE(0, 0);
    buffer.writeUInt16LE(1, 2);
    buffer.writeUInt16LE(1, 4);
    buffer.writeUInt8(0, 6);
    buffer.writeUInt8(0, 7);
    buffer.writeUInt8(0, 8);
    buffer.writeUInt8(0, 9);
    buffer.writeUInt16LE(1, 10);
    buffer.writeUInt16LE(32, 12);
    buffer.writeUInt32LE(pngBuffer.length, 14);
    buffer.writeUInt32LE(offset, 18);
    pngBuffer.copy(buffer, offset);
    return buffer;
}

fs.mkdirSync(iconDir, { recursive: true });
if (!fs.existsSync(svgPath)) throw new Error(`Missing SVG icon: ${svgPath}`);

const svg = fs.readFileSync(svgPath);
const png512 = await sharp(svg).resize(512, 512).png().toBuffer();
const png256 = await sharp(svg).resize(256, 256).png().toBuffer();

fs.writeFileSync(pngPath, png512);
fs.writeFileSync(icoPath, icoFromPng(png256));

console.log(`Wrote ${pngPath}`);
console.log(`Wrote ${icoPath}`);

/**
 * Проверка распознавания картинок: размер и тип из первых байтов.
 *
 * Нужна потому, что раньше разбирался только PNG, и архивы со Sketchfab
 * (там текстуры почти всегда JPEG) падали с «текстура не найдена» ещё до
 * разбора геометрии — 8 отказов из 40 в журнале были именно такими.
 *
 * Запуск: node tools/verify-images.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { imageSize, sniffMime } = require('../plugin/geckolib_model_importer.js');

let bad = 0;
const check = (label, bytes, want) => {
	const got = imageSize(bytes);
	const mime = sniffMime(bytes);
	const ok = got && got.width === want.width && got.height === want.height && mime === want.mime;
	if (!ok) bad++;
	console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(28)} ${got ? got.width + '×' + got.height : 'не прочитан'}  ${mime}`
		+ (ok ? '' : `   ожидалось ${want.width}×${want.height} ${want.mime}`));
};

// ---------------------------------------------------------- синтетика

const u8 = arr => Uint8Array.from(arr);
const be16 = n => [(n >> 8) & 0xFF, n & 0xFF];
const be32 = n => [(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];

console.log('\nСинтетические заголовки:');

// PNG: сигнатура + длина чанка + 'IHDR' + ширина + высота
check('PNG 64×32', u8([
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
	...be32(13), 0x49, 0x48, 0x44, 0x52,
	...be32(64), ...be32(32), 8, 6, 0, 0, 0,
]), { width: 64, height: 32, mime: 'image/png' });

// JPEG: SOI, потом APP0 который надо пропустить по длине, потом SOF0.
// Внутрь APP0 кладём байты, похожие на маркер SOF, — если пропуск сегментов
// сделан неверно, размер прочитается из мусора.
check('JPEG 1024×512 через APP0', u8([
	0xFF, 0xD8,
	0xFF, 0xE0, ...be16(10), 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xC0, 0x13,
	0xFF, 0xC0, ...be16(17), 8, ...be16(512), ...be16(1024), 3,
	1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
]), { width: 1024, height: 512, mime: 'image/jpeg' });

// JPEG прогрессивный: маркер SOF2 вместо SOF0 — тоже должен читаться
check('JPEG progressive 256×256', u8([
	0xFF, 0xD8,
	0xFF, 0xC2, ...be16(17), 8, ...be16(256), ...be16(256), 3,
	1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
	0, 0, 0, 0, 0, 0, 0, 0,
]), { width: 256, height: 256, mime: 'image/jpeg' });

// GIF: размер в logical screen descriptor, порядок байтов обратный
check('GIF 320×200', u8([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
	320 & 0xFF, 320 >> 8, 200 & 0xFF, 200 >> 8,
	0xF7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]), { width: 320, height: 200, mime: 'image/gif' });

// WebP lossy: 14 байт контейнера, потом VP8 с размерами по смещению 26
const vp8 = new Uint8Array(32);
vp8.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
new DataView(vp8.buffer).setUint16(26, 128, true);
new DataView(vp8.buffer).setUint16(28, 96, true);
check('WebP lossy 128×96', vp8, { width: 128, height: 96, mime: 'image/webp' });

// не картинка вовсе — должно вернуться null, а не случайные числа
const junk = new Uint8Array(64).fill(0x41);
console.log(`  ${imageSize(junk) === null ? '✅' : '❌'} мусор отвергается`);
if (imageSize(junk) !== null) bad++;

// ---------------------------------------------------------- настоящие файлы

console.log('\nНастоящие файлы из проекта:');
const roots = ['model', 'model(gltf)', '.'];
const found = [];
const walk = dir => {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) found.push(p);
	}
};
for (const r of roots) { walk(r); if (found.length) break; }

if (!found.length) {
	console.log('  (картинок в проекте не нашлось — пропускаем)');
} else {
	for (const p of found.slice(0, 10)) {
		const bytes = new Uint8Array(fs.readFileSync(p));
		const size = imageSize(bytes);
		if (!size) bad++;
		console.log(`  ${size ? '✅' : '❌'} ${path.basename(p).padEnd(28)} `
			+ `${size ? size.width + '×' + size.height : 'не прочитан'}  ${sniffMime(bytes)}`);
	}
}

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ ВСЕ ФОРМАТЫ КАРТИНОК ЧИТАЮТСЯ\n');
process.exit(bad ? 1 : 0);

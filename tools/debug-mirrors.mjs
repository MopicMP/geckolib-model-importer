/**
 * Диагностика отражённых UV: где они и как распределены.
 * Запуск: node tools/debug-mirrors.mjs model/model.obj
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox } = require('../plugin/geckolib_model_importer.js');

const file = process.argv[2] ?? 'model/model.obj';
const TEX = 128;

const positions = [], uvs = [], objects = [];
let current = null;
for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
	const line = raw.trim();
	if (!line || line[0] === '#') continue;
	const p = line.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(current = { name: p.slice(1).join(' '), faces: [] });
	else if (p[0] === 'f') {
		const corners = p.slice(1).map(tok => {
			const [v, t] = tok.split('/');
			return { v: +v - 1, t: t ? +t - 1 : -1 };
		});
		current.faces.push({
			positions: corners.map(c => positions[c.v]),
			uvs: corners.map(c => c.t < 0 ? null : [uvs[c.t][0] * TEX, (1 - uvs[c.t][1]) * TEX]),
		});
	}
}

const rows = [];
for (const obj of objects) {
	const sol = solveBox(obj.faces);
	if (sol.error) continue;
	const entries = Object.entries(sol.faceUV);
	const flippedU = entries.filter(([, uv]) => uv[0] > uv[2]).map(([n]) => n);
	const flippedV = entries.filter(([, uv]) => uv[1] > uv[3]).map(([n]) => n);
	rows.push({
		name: obj.name,
		center: sol.center.map(v => +(v * 16).toFixed(2)),   // в пикселях
		faces: entries.length,
		flippedU, flippedV,
		uv: sol.faceUV,
		size: sol.size.map(v => +(v * 16).toFixed(2)),
	});
}

// --- распределение по числу отражённых граней на куб ---
// ВАЖНО: считать И горизонталь, И вертикаль. Первая версия смотрела только на u
// и из-за этого не показывала v-отражения (напр. у cube_107) — потерянное время.
const flipCount = r => new Set([...r.flippedU, ...r.flippedV]).size;
const hist = new Map();
for (const r of rows) hist.set(flipCount(r), (hist.get(flipCount(r)) ?? 0) + 1);
console.log(`\n=== Отражённых граней (u или v) на куб ===`);
for (const [k, v] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  ${k} граней: ${v} кубов`);
}
console.log(`\n  только по u: ${rows.reduce((s, r) => s + r.flippedU.length, 0)} граней`);
console.log(`  только по v: ${rows.reduce((s, r) => s + r.flippedV.length, 0)} граней`);

const dirty = rows.filter(r => flipCount(r));
console.log(`\nВсего кубов с отражением: ${dirty.length} из ${rows.length}`);

// --- целиком ли отражены кубы? ---
const whole = dirty.filter(r => r.flippedU.length === r.faces);
console.log(`Отражены ЦЕЛИКОМ (все грани): ${whole.length}`);
console.log(`Отражены ЧАСТИЧНО           : ${dirty.length - whole.length}`);

// --- где они находятся ---
if (dirty.length) {
	const ys = dirty.map(r => r.center[1]);
	const xs = dirty.map(r => r.center[0]);
	console.log(`\nПоложение отражённых кубов (пиксели):`);
	console.log(`  Y (высота): ${Math.min(...ys).toFixed(1)} … ${Math.max(...ys).toFixed(1)}`);
	console.log(`  X (лево/право): ${Math.min(...xs).toFixed(1)} … ${Math.max(...xs).toFixed(1)}`);
	console.log(`  из них X<0: ${xs.filter(x => x < -0.01).length}, X>0: ${xs.filter(x => x > 0.01).length}, X≈0: ${xs.filter(x => Math.abs(x) <= 0.01).length}`);
}

const allY = rows.map(r => r.center[1]);
console.log(`\nДля сравнения, вся модель по Y: ${Math.min(...allY).toFixed(1)} … ${Math.max(...allY).toFixed(1)}`);

// --- есть ли у отражённого куба незеркальный двойник напротив по X? ---
console.log(`\n=== Поиск зеркальных пар ===`);
let paired = 0;
for (const r of dirty) {
	const twin = rows.find(o => o !== r
		&& Math.abs(o.center[0] + r.center[0]) < 0.05
		&& Math.abs(o.center[1] - r.center[1]) < 0.05
		&& Math.abs(o.center[2] - r.center[2]) < 0.05);
	const mark = twin ? (twin.flippedU.length ? 'двойник ТОЖЕ отражён' : `двойник ${twin.name} чистый`) : 'двойника нет';
	if (twin && !twin.flippedU.length) paired++;
	console.log(`  ${r.name.padEnd(10)} центр=[${r.center.join(', ')}] отражено:${r.flippedU.length}/6  → ${mark}`);
}
console.log(`\nОтражённых кубов с чистым зеркальным двойником: ${paired} из ${dirty.length}`);

// --- используют ли двойники одни и те же области текстуры? ---
// Если да, различие между ними ровно одно — отражение, и наша запись верна.
console.log(`\n=== Сверка текстурных областей у пар ===`);
const rectKey = uv => [Math.min(uv[0], uv[2]), Math.min(uv[1], uv[3]), Math.max(uv[0], uv[2]), Math.max(uv[1], uv[3])]
	.map(v => v.toFixed(2)).join('/');

for (const r of dirty.filter(d => d.flippedU.length === 6)) {
	const twin = rows.find(o => o !== r
		&& !o.flippedU.length
		&& Math.abs(o.center[0] + r.center[0]) < 0.05
		&& Math.abs(o.center[1] - r.center[1]) < 0.05
		&& Math.abs(o.center[2] - r.center[2]) < 0.05);
	if (!twin) continue;
	const a = Object.values(r.uv).map(rectKey).sort();
	const b = Object.values(twin.uv).map(rectKey).sort();
	const same = a.length === b.length && a.every((v, i) => v === b[i]);
	const sizeSame = r.size.join() === twin.size.join();
	console.log(`  ${r.name.padEnd(10)} ↔ ${twin.name.padEnd(10)} области ${same ? 'СОВПАДАЮТ' : 'РАЗНЫЕ'}, размеры ${sizeSame ? 'совпадают' : 'разные'}`);
	if (!same) {
		console.log(`      ${r.name}: ${a.join('  ')}`);
		console.log(`      ${twin.name}: ${b.join('  ')}`);
	}
}
console.log('');

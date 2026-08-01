/**
 * Фаза 0 — анализатор OBJ.
 * Отвечает на вопрос: можно ли конвертировать модель в кубы без потерь?
 *
 * Запуск: node tools/analyze-obj.mjs model/model.obj
 */
import fs from 'node:fs';

const EPS = 1e-5;
const file = process.argv[2] ?? 'model/model.obj';

// ---------- парсинг ----------
const positions = [];   // [x,y,z]
const uvs = [];         // [u,v]
const normalsList = []; // [x,y,z]
const objects = [];     // { name, tris: [[vi,ti,ni], x3] }
let current = null;

for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
	const line = raw.trim();
	if (!line || line[0] === '#') continue;
	const parts = line.split(/\s+/);
	switch (parts[0]) {
		case 'v':
			positions.push([+parts[1], +parts[2], +parts[3]]);
			break;
		case 'vt':
			uvs.push([+parts[1], +parts[2]]);
			break;
		case 'vn':
			normalsList.push([+parts[1], +parts[2], +parts[3]]);
			break;
		case 'o':
			current = { name: parts.slice(1).join(' '), tris: [] };
			objects.push(current);
			break;
		case 'f': {
			if (!current) { current = { name: '<unnamed>', tris: [] }; objects.push(current); }
			// поддерживаем только треугольники и квады
			const corners = parts.slice(1).map(tok => {
				const [v, t, nn] = tok.split('/');
				return [+v - 1, t ? +t - 1 : -1, nn ? +nn - 1 : -1];
			});
			for (let i = 1; i + 1 < corners.length; i++) {
				current.tris.push([corners[0], corners[i], corners[i + 1]]);
			}
			break;
		}
	}
}

// ---------- вектора ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a); return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; };
const key = a => a.map(n => (Math.abs(n) < EPS ? 0 : n).toFixed(5)).join(',');

// ---------- анализ одного объекта ----------
function analyze(obj) {
	const idx = new Set();
	for (const tri of obj.tris) for (const [vi] of tri) idx.add(vi);

	const uniq = new Map();
	for (const i of idx) uniq.set(key(positions[i]), positions[i]);
	const pts = [...uniq.values()];

	// нормали берём из самого OBJ — вычисленные через cross вырождаются на тонких гранях
	const normals = new Map();
	for (const tri of obj.tris) for (const [, , ni] of tri) {
		if (ni >= 0) { const n = norm(normalsList[ni]); if (len(n) > 0.5) normals.set(key(n), n); }
	}
	const ns = [...normals.values()];

	// три ортогональные оси из нормалей (игнорируя знак)
	const axes = [];
	for (const n of ns) {
		if (!axes.some(a => Math.abs(Math.abs(dot(a, n)) - 1) < 1e-3)) axes.push(n);
	}

	const orthogonal = axes.length === 3 &&
		Math.abs(dot(axes[0], axes[1])) < 1e-3 &&
		Math.abs(dot(axes[1], axes[2])) < 1e-3 &&
		Math.abs(dot(axes[0], axes[2])) < 1e-3;

	// размеры вдоль осей + проверка что это реально ящик:
	// каждая вершина должна лежать в углу — её проекция на каждую ось равна min либо max
	let size = null, isBox = false, degenerate = false;
	if (orthogonal) {
		const ranges = axes.map(a => {
			const ds = pts.map(p => dot(p, a));
			return [Math.min(...ds), Math.max(...ds)];
		});
		size = ranges.map(([lo, hi]) => hi - lo);
		const scale = Math.max(...size, EPS);
		const tol = scale * 1e-4;            // относительный допуск
		degenerate = size.some(s => s < scale * 1e-3);
		isBox = pts.length === 8 && pts.every(p =>
			axes.every((a, i) => {
				const d = dot(p, a);
				return Math.abs(d - ranges[i][0]) < tol || Math.abs(d - ranges[i][1]) < tol;
			})
		);
	}

	const axisAligned = orthogonal && axes.every(a =>
		a.filter(c => Math.abs(Math.abs(c) - 1) < 1e-3).length === 1 &&
		a.filter(c => Math.abs(c) < 1e-3).length === 2
	);

	// UV: сколько квадов имеют осевой прямоугольник в UV-пространстве
	// собираем треугольники в квады по нормали
	const byNormal = new Map();
	for (const tri of obj.tris) {
		const ni = tri[0][2];
		const n = ni >= 0
			? key(norm(normalsList[ni]))
			: key(norm(cross(sub(positions[tri[1][0]], positions[tri[0][0]]), sub(positions[tri[2][0]], positions[tri[0][0]]))));
		if (!byNormal.has(n)) byNormal.set(n, []);
		byNormal.get(n).push(tri);
	}
	let uvRect = 0, uvTotal = 0, uvMissing = 0, uvSkewed = 0, faceDegen = 0;
	const modelScale = Math.max(...(size ?? [1]), EPS);
	for (const [, tris] of byNormal) {
		// площадь грани в 3D — вырожденные (у плоских панелей) не рендерятся, их можно выбросить
		const area = tris.reduce((s, tri) =>
			s + len(cross(sub(positions[tri[1][0]], positions[tri[0][0]]), sub(positions[tri[2][0]], positions[tri[0][0]]))) / 2, 0);
		if (area < modelScale * modelScale * 1e-6) { faceDegen++; continue; }

		uvTotal++;
		const us = new Set(), vs = new Set();
		let missing = false;
		for (const tri of tris) for (const [, ti] of tri) {
			if (ti < 0) { missing = true; continue; }
			us.add(uvs[ti][0].toFixed(5));
			vs.add(uvs[ti][1].toFixed(5));
		}
		if (missing) { uvMissing++; continue; }
		// осевой прямоугольник (в т.ч. повёрнутый на 90/180/270) даёт ровно 2 u и 2 v
		if (us.size <= 2 && vs.size <= 2) uvRect++;
		else uvSkewed++;
	}

	return { name: obj.name, verts: pts.length, faces: byNormal.size, tris: obj.tris.length, isBox, degenerate, axisAligned, orthogonal, axes, size, pts, uvRect, uvTotal, uvMissing, uvSkewed, faceDegen };
}

const results = objects.map(analyze);

// ---------- отчёт ----------
const n = results.length;
const boxes = results.filter(r => r.isBox && !r.degenerate);
const flats = results.filter(r => r.isBox && r.degenerate);
const other = results.filter(r => !r.isBox);
const aligned = results.filter(r => r.axisAligned);
const rotated = results.filter(r => r.orthogonal && !r.axisAligned);

const pct = k => `${((k / n) * 100).toFixed(1)}%`;

console.log(`\n=== ГЕОМЕТРИЯ (${n} объектов) ===`);
console.log(`  идеальные ящики      : ${boxes.length}  (${pct(boxes.length)})`);
console.log(`  плоские (нулевая ось): ${flats.length}  (${pct(flats.length)})`);
console.log(`  НЕ ящики             : ${other.length}  (${pct(other.length)})`);
console.log(`  из них по осям (AABB): ${aligned.length}  (${pct(aligned.length)})`);
console.log(`  повёрнутые (OBB)     : ${rotated.length}  (${pct(rotated.length)})`);

if (other.length) {
	console.log(`\n  примеры не-ящиков:`);
	for (const r of other.slice(0, 10)) {
		console.log(`    ${r.name}: ${r.verts} верт, ${r.faces} граней, ортогональ=${r.orthogonal}`);
	}
}

// углы поворота повёрнутых
if (rotated.length) {
	console.log(`\n=== ПОВОРОТЫ (${rotated.length}) ===`);
	const angles = new Map();
	for (const r of rotated) {
		for (const a of r.axes) {
			for (const [name, base] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]]) {
				const deg = (Math.acos(Math.min(1, Math.abs(dot(a, base)))) * 180 / Math.PI).toFixed(2);
				if (+deg > 0.01 && +deg < 89.99) angles.set(`${name}:${deg}`, (angles.get(`${name}:${deg}`) ?? 0) + 1);
			}
		}
	}
	console.log(`  встречающиеся углы к осям:`, [...angles.keys()].slice(0, 20).join(' '));
}

// UV
const uvRect = results.reduce((s, r) => s + r.uvRect, 0);
const uvTotal = results.reduce((s, r) => s + r.uvTotal, 0);
const uvMissing = results.reduce((s, r) => s + r.uvMissing, 0);
const faceDegen = results.reduce((s, r) => s + r.faceDegen, 0);
console.log(`\n=== UV (${uvTotal} видимых граней; ${faceDegen} вырожденных отброшено) ===`);
console.log(`  осевой прямоугольник : ${uvRect}  (${((uvRect / uvTotal) * 100).toFixed(1)}%)  -> переносится 1:1`);
console.log(`  без UV               : ${uvMissing}`);
console.log(`  кривые/скошенные     : ${uvTotal - uvRect - uvMissing}  -> потребуют запекания`);

// грани на объект
const faceHist = new Map();
for (const r of results) faceHist.set(r.faces, (faceHist.get(r.faces) ?? 0) + 1);
console.log(`\n  граней на объект:`, [...faceHist.entries()].sort((a, b) => b[0] - a[0]).map(([f, c]) => `${f}гр×${c}`).join('  '));

// габариты и масштаб
let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const p of positions) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
console.log(`\n=== ГАБАРИТЫ ===`);
console.log(`  min: ${min.map(v => v.toFixed(4)).join(', ')}`);
console.log(`  max: ${max.map(v => v.toFixed(4)).join(', ')}`);
console.log(`  размер (ед.): ${max.map((v, i) => (v - min[i]).toFixed(4)).join(' x ')}`);
console.log(`  размер (×16 = пиксели MC): ${max.map((v, i) => ((v - min[i]) * 16).toFixed(2)).join(' x ')}`);

// сетка: попадают ли координаты на пиксельную сетку
const gridHits = { p16: 0, p1: 0, total: 0 };
for (const p of positions) for (const c of p) {
	gridHits.total++;
	if (Math.abs(c * 16 - Math.round(c * 16)) < 1e-4) gridHits.p16++;
	if (Math.abs(c * 16 * 16 - Math.round(c * 16 * 16)) < 1e-4) gridHits.p1++;
}
console.log(`  координат на сетке 1px  : ${((gridHits.p16 / gridHits.total) * 100).toFixed(1)}%`);
console.log(`  координат на сетке 1/16px: ${((gridHits.p1 / gridHits.total) * 100).toFixed(1)}%`);

// размеры кубов в пикселях
const sizesPx = new Set();
for (const r of boxes) sizesPx.add(r.size.map(s => (s * 16).toFixed(3)).sort().join('x'));
console.log(`\n  уникальных размеров кубов: ${sizesPx.size}`);
console.log(`  примеры (px):`, [...sizesPx].slice(0, 8).join('  '));
console.log('');

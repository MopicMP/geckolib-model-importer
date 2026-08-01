/**
 * Приближение не-ящиков габаритным ящиком: как ложится текстура.
 *
 * Модели, помеченные «сломанные текстуры», состоят из клиньев и скосов —
 * геометрии, которой в Minecraft не бывает. Форму такой объект теряет
 * неизбежно, но раньше он получал ОДИН прямоугольник UV на все шесть граней,
 * и каждая сторона показывала габарит всей развёртки разом. Отсюда каша.
 *
 * Запуск: node tools/verify-approx.mjs [папка с распакованными моделями]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boxFromBounds, triangleNormal, solveBox, splitComponents, parseGLTFFiles } =
	require('../plugin/geckolib_model_importer.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

// ------------------------------------------------------------ нормаль

console.log('\n=== Нормаль треугольника ===');
const n1 = triangleNormal([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
ok(n1 && Math.abs(n1[2] - 1) < 1e-9, 'треугольник в плоскости XY смотрит по +Z');
ok(!triangleNormal([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), 'вырожденный треугольник даёт null');
ok(!triangleNormal([[0, 0, 0], [1, 0, 0]]), 'двух точек мало');

// ------------------------------------------------- UV раскладываются по граням

console.log('\n=== Клин: каждой грани свой кусок текстуры ===');

// клин: снизу квадрат, сверху скошено — ровно то, что встречается в моделях
const quad = (p0, p1, p2, p3, uv0, uv1, uv2, uv3) => ([
	{ positions: [p0, p1, p2], uvs: [uv0, uv1, uv2] },
	{ positions: [p0, p2, p3], uvs: [uv0, uv2, uv3] },
]);
// Обход вершин задаёт направление нормали, поэтому у каждой грани он свой:
// низ обходится так, чтобы нормаль смотрела вниз, и так далее.
const wedge = [
	// низ: нормаль -Y
	...quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]),
	// верх: нормаль +Y
	...quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0], [0.5, 0.5], [0.5, 0.6], [0.6, 0.6], [0.6, 0.5]),
	// перед: нормаль -Z
	...quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [0.2, 0.2], [0.2, 0.3], [0.3, 0.3], [0.3, 0.2]),
];
const sol = boxFromBounds(wedge);
ok(!!sol && sol.approximated, 'габаритный ящик построен и помечен приближённым');

const rects = Object.entries(sol.faceUV).map(([k, v]) => [k, v.join(',')]);
const unique = new Set(rects.map(r => r[1]));
ok(unique.size > 1, `у граней разные прямоугольники UV (различных: ${unique.size})`);
ok(sol.faceUV.down.join(',') === '0,0,0.1,0.1', `низ взял свой кусок: ${sol.faceUV.down.join(',')}`);
ok(sol.faceUV.up.join(',') === '0.5,0.5,0.6,0.6', `верх взял свой кусок: ${sol.faceUV.up.join(',')}`);
ok(sol.faceUV.north.join(',') === '0.2,0.2,0.3,0.3', `перед взял свой кусок: ${sol.faceUV.north.join(',')}`);
// грани без треугольников достаётся общий габарит — пустой стороны быть не должно
ok(sol.faceUV.east.join(',') === '0,0,0.6,0.6', 'грань без своих треугольников берёт общий габарит');

// ------------------------------------------------- на настоящих моделях

const root = process.argv[2];
if (root && fs.existsSync(root)) {
	const readDir = dir => {
		const files = {};
		const walk = (d, p) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const q = path.join(d, e.name);
				if (e.isDirectory()) walk(q, p + e.name + '/');
				else files[p + e.name] = new Uint8Array(fs.readFileSync(q));
			}
		};
		walk(dir, '');
		return files;
	};

	console.log('\n=== Настоящие модели с жалобой «сломаны текстуры» ===');
	const dirs = [];
	const collect = d => {
		const es = fs.readdirSync(d, { withFileTypes: true });
		if (es.some(e => e.isFile())) { dirs.push(d); return; }
		for (const e of es) if (e.isDirectory()) collect(path.join(d, e.name));
	};
	collect(root);

	for (const dir of dirs) {
		let parsed;
		try { parsed = parseGLTFFiles(readDir(dir), { scale: 1, uvWidth: 1, uvHeight: 1 }); } catch { continue; }
		let approx = 0, distinct = 0, single = 0;
		for (const obj of parsed.objects) {
			for (const faces of splitComponents(obj.faces)) {
				if (!solveBox(faces).error) continue;
				const s = boxFromBounds(faces);
				if (!s) continue;
				approx++;
				const u = new Set(Object.values(s.faceUV).map(r => r.join(',')));
				if (u.size > 1) distinct++; else single++;
			}
		}
		if (!approx) continue;
		console.log(`  ${path.relative(root, dir).replace(/[\/]source$/, "").padEnd(38)} приближено ${String(approx).padStart(4)}: `
			+ `с разными UV по граням ${String(distinct).padStart(4)}, с одинаковыми ${single}`);
	}
}

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ ПРИБЛИЖЕНИЕ РАСКЛАДЫВАЕТ UV ПО ГРАНЯМ\n');
process.exit(bad ? 1 : 0);

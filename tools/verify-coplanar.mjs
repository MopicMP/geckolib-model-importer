/**
 * Развод совпадающих граней через inflate.
 *
 * Два куба в одной плоскости дают рябь: видеокарта не может решить, какая
 * грань ближе. Сдвигать координаты нельзя — вместо ровного 5 в панели появится
 * 4.99432. Вместо этого меньший куб пары чуть раздувается полем inflate.
 *
 * Проверяются и повёрнутые кубы: у них from/to локальные, и габаритный ящик
 * из center ± size/2 не совпадает с настоящим положением.
 *
 * Запуск: node tools/verify-coplanar.mjs [папка с распакованными моделями]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCoplanar, cubeFaces, solveBox, splitComponents, parseGLTFFiles } =
	require('../plugin/geckolib_model_importer.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

/** Неповёрнутый куб по габаритам. */
const box = (lo, hi) => ({
	center: [0, 1, 2].map(i => (lo[i] + hi[i]) / 2),
	size: [0, 1, 2].map(i => hi[i] - lo[i]),
	vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1],
});

/** Куб, повёрнутый вокруг Y на угол deg. */
const turned = (lo, hi, deg) => {
	const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
	return Object.assign(box(lo, hi), { vx: [c, 0, -s], vy: [0, 1, 0], vz: [s, 0, c] });
};

/** Куб по центру и размеру, повёрнутый вокруг Y. */
const turnedAt = (center, size, deg) => {
	const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
	return { center, size, vx: [c, 0, -s], vy: [0, 1, 0], vz: [s, 0, c] };
};

/**
 * Накладка на переднюю грань повёрнутого куба.
 *
 * Каждый куб вращается вокруг СВОЕГО origin, поэтому одинаковый угол ещё не
 * означает общей плоскости: у кубов с разными центрами передние грани
 * расходятся. Чтобы грани совпали, центр накладки надо сместить вдоль
 * локальной оси на разницу полуразмеров.
 */
const facingOverlay = (base, size, deg) => {
	const r = deg * Math.PI / 180, s = Math.sin(r), c = Math.cos(r);
	const shift = base.size[2] / 2 - size[2] / 2;
	return turnedAt(
		[base.center[0] + s * shift, base.center[1], base.center[2] + c * shift],
		size, deg);
};

console.log('\n=== Осевые кубы ===');

let r = resolveCoplanar([box([0, 0, 0], [16, 16, 16]), box([2, 2, 2], [14, 14, 16])]);
ok(r.pairs === 1, `совпадающие передние грани — конфликт (пар: ${r.pairs})`);
ok(r.inflate[0] === 0 && r.inflate[1] > 0,
	`раздут меньший куб, большой не тронут (${r.inflate[0]}, ${r.inflate[1]})`);

r = resolveCoplanar([box([0, 0, 0], [16, 16, 16]), box([0, 16, 0], [16, 24, 16])]);
ok(r.pairs === 0, `стык кубов друг на друге — не конфликт (пар: ${r.pairs})`);

r = resolveCoplanar([box([0, 0, 0], [8, 8, 8]), box([8, 0, 8], [16, 8, 16])]);
ok(r.pairs === 0, `касание ребром — не конфликт (пар: ${r.pairs})`);

r = resolveCoplanar([box([0, 0, 0], [8, 8, 8]), box([40, 40, 40], [48, 48, 48])]);
ok(r.pairs === 0, 'разнесённые кубы — не конфликт');

console.log('\n=== Слои расходятся на разную глубину ===');
r = resolveCoplanar([
	box([0, 0, 0], [16, 16, 16]),
	box([1, 1, 1], [15, 15, 16]),
	box([2, 2, 2], [14, 14, 16]),
]);
ok(r.inflate[0] === 0, `основа не раздута (${r.inflate[0]})`);
ok(r.inflate[1] > r.inflate[0] && r.inflate[2] > r.inflate[1],
	`каждый слой глубже: ${r.inflate[0]} < ${r.inflate[1].toFixed(3)} < ${r.inflate[2].toFixed(3)}`);

console.log('\n=== Повёрнутые кубы ===');

// Оба повёрнуты одинаково и лежат в одной плоскости — рябь будет.
const base30 = turnedAt([8, 8, 8], [16, 16, 16], 30);
r = resolveCoplanar([base30, facingOverlay(base30, [12, 12, 12], 30)]);
ok(r.pairs === 1, `накладка на повёрнутом кубе — конфликт (пар: ${r.pairs})`);
ok(r.inflate[0] === 0 && r.inflate[1] > 0, 'раздута накладка, основа не тронута');

// Одинаковый угол, но разные центры: каждый куб вращается вокруг своего
// origin, поэтому передние грани расходятся и общей плоскости нет.
r = resolveCoplanar([turned([0, 0, 0], [16, 16, 16], 30), turned([2, 2, 2], [14, 14, 16], 30)]);
ok(r.pairs === 0, `смещённый куб под тем же углом — плоскости разные (пар: ${r.pairs})`);

// Повёрнуты по-разному: плоскости граней не совпадают тем более.
r = resolveCoplanar([base30, facingOverlay(base30, [12, 12, 12], 31)]);
ok(r.pairs === 0, `разный угол — конфликта нет (пар: ${r.pairs})`);

// Поворот на 90°: базис становится перестановкой осей. Раньше габаритный ящик
// считался покомпонентно и врал именно здесь.
const a90 = turned([0, 0, 0], [4, 16, 16], 90);
const b90 = turned([0, 0, 0], [4, 12, 12], 90);
r = resolveCoplanar([a90, b90]);
ok(r.pairs >= 1, `поворот на 90° — совпадение найдено (пар: ${r.pairs})`);

console.log('\n=== Грани строятся в мировых координатах ===');
const f = cubeFaces(turned([0, 0, 0], [16, 16, 16], 90));
const normals = f.map(x => x.n.map(v => Math.round(v)).join(','));
ok(normals.includes('1,0,0') || normals.includes('-1,0,0'), 'есть грань вдоль мирового X');
ok(f.every(x => Math.abs(Math.hypot(...x.n) - 1) < 1e-9), 'все нормали единичные');
ok(f.length === 6, `граней ровно шесть (${f.length})`);

console.log('\n=== Предохранитель на огромных моделях ===');
const many = [];
for (let i = 0; i < 30; i++) many.push(box([0, 0, 0], [1, 1, 1]));
r = resolveCoplanar(many, 0.02, 10);
ok(r.skipped === 30 && r.pairs === 0, `при превышении предела развод пропускается (skipped ${r.skipped})`);

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
	const dirs = [];
	const collect = d => {
		const es = fs.readdirSync(d, { withFileTypes: true });
		if (es.some(e => e.isFile())) { dirs.push(d); return; }
		for (const e of es) if (e.isDirectory()) collect(path.join(d, e.name));
	};
	collect(root);

	console.log('\n=== На настоящих моделях (масштаб ×16) ===');
	console.log('  модель                                кубов  повёрнутых   пар  раздуто  макс.');
	for (const dir of dirs) {
		let parsed;
		try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }
		const sols = [];
		for (const obj of parsed.objects) {
			for (const faces of splitComponents(obj.faces)) {
				const sol = solveBox(faces);
				if (!sol.error) sols.push(sol);
			}
		}
		if (!sols.length) continue;
		const rotated = sols.filter(s => ![s.vx, s.vy, s.vz].every(v =>
			v.filter(c => Math.abs(Math.abs(c) - 1) < 1e-6).length === 1)).length;
		const res = resolveCoplanar(sols);
		const touched = res.inflate.filter(v => v > 0).length;
		const max = res.inflate.reduce((x, y) => Math.max(x, y), 0);
		const label = path.relative(root, dir).replace(/[/\\]source$/, '');
		console.log(`  ${label.slice(0, 36).padEnd(38)} ${String(sols.length).padStart(5)} `
			+ `${String(rotated).padStart(11)} ${String(res.pairs).padStart(5)} `
			+ `${String(touched).padStart(8)} ${max.toFixed(3).padStart(6)}`);
		if (max > 0.125) { bad++; console.log('    ❌ раздутие превысило половину шага сетки — станет заметно'); }
	}
}

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ СОВПАДАЮЩИЕ ГРАНИ РАЗВОДЯТСЯ\n');
process.exit(bad ? 1 : 0);

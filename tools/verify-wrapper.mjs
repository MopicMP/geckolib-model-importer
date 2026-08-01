/**
 * Обёртка выгрузки: что сохранять, а что выбрасывать.
 *
 * Восемь моделей из журнала были помечены «требуется поворот -90°». Причина
 * оказалась одна: в служебной обёртке Sketchfab лежат ДВЕ разные вещи —
 * конверсия осей (Z-up → Y-up, поворот кратен 90°) и постановка модели
 * в витрине (произвольный поворот и сдвиг). Выбрасывались обе, и модель
 * приезжала лежащей.
 *
 * Запуск: node tools/verify-wrapper.mjs [папка с распакованными архивами]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { axisRotationOf, parseGLTFFiles } = require('../plugin/geckolib_model_importer.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

// ------------------------------------------------- распознавание поворота

console.log('\n=== Осевой поворот отличается от произвольного ===');

const q90x = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
ok(axisRotationOf({ rotation: q90x }), '90° вокруг X — осевой (конверсия Z-up → Y-up)');
ok(axisRotationOf({ rotation: [0, 0, 0, 1] }), 'нулевой поворот — осевой');
ok(axisRotationOf({ rotation: [0, 1, 0, 0] }), '180° вокруг Y — осевой');
ok(!axisRotationOf({ rotation: [0.1366, 0.603, 0.7666, -0.1736] }),
	'160° вокруг косой оси — произвольный (постановка в витрине)');
ok(!axisRotationOf({ rotation: [0.3827, 0, 0, 0.9239] }), '45° вокруг X — произвольный');
ok(!axisRotationOf({}), 'узел без поворота — нечего сохранять');

// матрица Sketchfab-12.67: X→X, Y→-Z, Z→Y, то есть -90° вокруг X
const mSketchfab = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
ok(axisRotationOf({ matrix: mSketchfab }), 'матрица -90° вокруг X — осевой');

// вырожденная матрица: две оси схлопнуты в одну — это не поворот
const mBroken = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
ok(!axisRotationOf({ matrix: mBroken }), 'схлопнутые оси — не поворот');

// сдвиг обёртки не должен просачиваться в результат
const withShift = axisRotationOf({ rotation: q90x, translation: [6.3, -3.7, -62.4] });
ok(withShift && withShift.matrix[12] === 0 && withShift.matrix[13] === 0 && withShift.matrix[14] === 0,
	'сдвиг обёртки отброшен, остался только поворот');

// ------------------------------------------------- на настоящих архивах

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
	console.log('\n(папка с распакованными архивами не указана — проверка на живых моделях пропущена)');
	console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ РАЗБОР ОБЁРТКИ ВЕРЕН\n');
	process.exit(bad ? 1 : 0);
}

/** Габарит модели по осям: у стоящей фигуры высота больше ширины и глубины. */
function extent(objects) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const o of objects) {
		for (const f of o.faces) {
			for (const p of f.positions) {
				for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
			}
		}
	}
	return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

const readDir = dir => {
	const files = {};
	const walk = (d, prefix) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, prefix + e.name + '/');
			else files[prefix + e.name] = new Uint8Array(fs.readFileSync(p));
		}
	};
	walk(dir, '');
	return files;
};

console.log('\n=== Габариты живых моделей (Ш × В × Г) ===');
for (const name of fs.readdirSync(root)) {
	const dir = path.join(root, name);
	if (!fs.statSync(dir).isDirectory()) continue;
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 1, uvWidth: 1, uvHeight: 1 }); }
	catch (e) { console.log(`  ${name}: не разобрался — ${e.message}`); continue; }

	const [w, h, d] = extent(parsed.objects).map(v => +v.toFixed(2));
	const wrapWarn = parsed.warnings.filter(x => x.indexOf('обёртка') >= 0);
	console.log(`  ${name.padEnd(16)} ${String(w).padStart(7)} × ${String(h).padStart(7)} × ${String(d).padStart(7)}`
		+ `   ${h >= Math.max(w, d) ? 'стоит' : 'лежит или широкая'}`);
	for (const x of wrapWarn) console.log(`      ${x}`);
}

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ РАЗБОР ОБЁРТКИ ВЕРЕН\n');
process.exit(bad ? 1 : 0);

/**
 * Совпадающие грани (z-fighting): где кубы лежат в одной плоскости.
 *
 * Видеокарта не может решить, какая из двух совпадающих граней ближе, и на
 * модели идёт рябь. Инструмент считает, сколько таких мест и какого они рода —
 * от этого зависит, чем лечить.
 *
 * Запуск: node tools/analyze-zfight.mjs <папка с распакованными моделями>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGLTFFiles, solveBox, splitComponents, snapVec } = require('../plugin/geckolib_model_importer.js');

const root = process.argv[2];
if (!root) { console.log('Укажите папку с распакованными моделями'); process.exit(1); }

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

const EPS = 1e-6;
const AXES = ['X', 'Y', 'Z'];

console.log('');
for (const dir of dirs) {
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }

	// Берём только осевые кубы: у повёрнутых плоскости совпадают редко,
	// а сравнивать их пришлось бы совсем иначе.
	const boxes = [];
	for (const obj of parsed.objects) {
		for (const faces of splitComponents(obj.faces)) {
			const sol = solveBox(faces);
			if (sol.error) continue;
			const axisAligned = [sol.vx, sol.vy, sol.vz].every(v =>
				v.filter(c => Math.abs(Math.abs(c) - 1) < 1e-6).length === 1
				&& v.filter(c => Math.abs(c) < 1e-6).length === 2);
			if (!axisAligned) continue;
			const half = sol.size.map(v => Math.abs(v) / 2);
			boxes.push({
				name: obj.name,
				lo: snapVec(sol.center.map((c, i) => c - half[i])),
				hi: snapVec(sol.center.map((c, i) => c + half[i])),
				vol: half.reduce((a, b) => a * 2 * b, 1),
			});
		}
	}

	// Пара граней конфликтует, если лежит в одной плоскости и проекции
	// перекрываются по площади (касание ребром безобидно).
	let sameSide = 0, backToBack = 0, covered = 0, partial = 0;
	const examples = [];
	const overlap = (a, b, skip) => {
		for (let i = 0; i < 3; i++) {
			if (i === skip) continue;
			const lo = Math.max(a.lo[i], b.lo[i]);
			const hi = Math.min(a.hi[i], b.hi[i]);
			if (hi - lo <= EPS) return 0;
		}
		let area = 1;
		for (let i = 0; i < 3; i++) {
			if (i === skip) continue;
			area *= Math.min(a.hi[i], b.hi[i]) - Math.max(a.lo[i], b.lo[i]);
		}
		return area;
	};

	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i], b = boxes[j];
			for (let ax = 0; ax < 3; ax++) {
				const area = overlap(a, b, ax);
				if (!area) continue;
				// одна сторона: обе грани смотрят наружу в одну сторону — рябь видна
				const sameLo = Math.abs(a.lo[ax] - b.lo[ax]) < EPS;
				const sameHi = Math.abs(a.hi[ax] - b.hi[ax]) < EPS;
				// спина к спине: конец одного совпал с началом другого
				const touch = Math.abs(a.hi[ax] - b.lo[ax]) < EPS || Math.abs(b.hi[ax] - a.lo[ax]) < EPS;
				if (sameLo || sameHi) {
					sameSide++;
					// Вложен ли один куб в другой ЦЕЛИКОМ, по всем трём осям.
					// Только тогда его грани действительно не видны и их можно
					// не рисовать. У просто копланарных граней ни одна другую
					// не закрывает — они на одной глубине, потому и рябь.
					const within = (x, y) => {
						for (let i = 0; i < 3; i++) {
							if (x.lo[i] < y.lo[i] - EPS || x.hi[i] > y.hi[i] + EPS) return false;
						}
						return true;
					};
					const nested = within(a, b) || within(b, a);
					if (nested) covered++;
					else partial++;
					if (examples.length < 3) {
						examples.push(`${a.name} / ${b.name} — общая плоскость по ${AXES[ax]}`
							+ `, площадь ${area.toFixed(2)} px²`
							+ (nested ? ' — один куб вложен в другой целиком' : ' — кубы просто копланарны'));
					}
				} else if (touch) {
					backToBack++;
				}
			}
		}
	}

	if (!boxes.length) continue;
	const label = path.relative(root, dir).replace(/[/\\]source$/, '');
	console.log(`### ${label}`);
	console.log(`    осевых кубов ${boxes.length} · совпадающих граней «в одну сторону» ${sameSide}`
		+ ` · стыков «спина к спине» ${backToBack}`);
	if (sameSide) console.log(`      из совпадающих: один куб вложен в другой ${covered}, просто копланарны ${partial}`);
	for (const e of examples) console.log(`      ${e}`);
}
console.log('');

/**
 * Привязка координат к сетке 0.25 px: насколько она искажает модель.
 *
 * Числа вроде -4.3979 неудобны в редакторе, но округление меняет геометрию.
 * Здесь меряется цена — и меряется В МИРОВЫХ КООРДИНАТАХ.
 *
 * Первая версия теста мерила смещение from/to, то есть в локальной системе
 * куба, и показывала безобидные 0.125 px. Но положение вершины повёрнутого
 * куба — origin + R·(p − origin): origin, привязанный отдельно от from/to,
 * уводил вершины до 0.46 px, и прямоугольные детали становились косыми.
 * Тест этого не видел, а пользователь увидел сразу.
 *
 * Запуск: node tools/verify-snap.mjs [папка с распакованными моделями]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { snapGrid, snapVec, snapAngle, isIdentityBasis, snapSafely, placeCoords,
	solveBox, splitComponents, parseGLTFFiles } = require('../plugin/geckolib_model_importer.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

console.log('\n=== Сама привязка ===');
ok(snapGrid(-4.3979) === -4.5, `-4.3979 → ${snapGrid(-4.3979)}`);
ok(snapGrid(0.0005) === 0, `0.0005 → ${snapGrid(0.0005)}`);
ok(snapGrid(7.5312) === 7.5, `7.5312 → ${snapGrid(7.5312)}`);
ok(!Object.is(snapGrid(-0.001), -0), 'минус ноль не появляется');
ok(snapAngle(22.4998) === 22.5, `угол 22.4998° → ${snapAngle(22.4998)}°`);
ok(snapVec([1.1, 2.2, 3.3]).join(',') === '1,2.25,3.25', `вектор: ${snapVec([1.1, 2.2, 3.3]).join(',')}`);

console.log('\n=== Кого можно привязывать ===');
const I = { vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1] };
ok(isIdentityBasis(I), 'куб без поворота — привязываем');
ok(!isIdentityBasis({ vx: [0, 0, 1], vy: [0, 1, 0], vz: [-1, 0, 0] }),
	'поворот на 90° — базис осевой, но не единичный: не привязываем');
ok(!isIdentityBasis({ vx: [0.87, 0, -0.5], vy: [0, 1, 0], vz: [0.5, 0, 0.87] }),
	'поворот на 30° — не привязываем');

console.log('\n=== Привязка не должна ломать мелкие детали ===');
const solOf = (center, size, basis) => Object.assign(
	{ center, size }, basis || { vx: [1, 0, 0], vy: [0, 1, 0], vz: [0, 0, 1] });

ok(snapSafely(solOf([8, 8, 8], [6, 7.5, 5])), 'крупный куб по сетке — привязываем');
ok(!snapSafely(solOf([3.3, 5.1, 2.05], [0.6, 0.7, 0.001])),
	'зрачок 0.6×0.7×0.001 — НЕ привязываем: вырос бы на четверть и потерял толщину');
ok(!snapSafely(solOf([3, 5, 2], [5, 0.001, 2])),
	'тонкая накладка — не привязываем: толщина схлопнулась бы в ноль');
ok(snapSafely(solOf([4.00001, 8, 8], [6, 8, 4])), 'разрядный мусор — чистим привязкой');
ok(!snapSafely(solOf([8, 8, 8], [6, 7.5, 5], { vx: [0.87, 0, -0.5], vy: [0, 1, 0], vz: [0.5, 0, 0.87] })),
	'повёрнутый куб — не привязываем никогда');

/** Восемь вершин куба в МИРЕ: origin + R·(вершина − origin). */
const corners = (from, to, origin, basis) => {
	const out = [];
	for (const x of [from[0], to[0]]) {
		for (const y of [from[1], to[1]]) {
			for (const z of [from[2], to[2]]) {
				const d = [x - origin[0], y - origin[1], z - origin[2]];
				out.push([0, 1, 2].map(k =>
					origin[k] + basis[0][k] * d[0] + basis[1][k] * d[1] + basis[2][k] * d[2]));
			}
		}
	}
	return out;
};

// Расстановку координат берём из самого плагина, а не повторяем здесь.
// Своя копия логики означала бы, что тест проверяет сам себя: расходись она
// с плагином — и он бы этого не заметил.
const placeOf = placeCoords;

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
	console.log('\n(папка с моделями не указана — цена привязки не измерена)');
	console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ ПРИВЯЗКА К СЕТКЕ РАБОТАЕТ\n');
	process.exit(bad ? 1 : 0);
}

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

console.log('\n=== Смещение вершин в мире (масштаб ×16) ===');
console.log('  модель                                кубов  прямых  косых   макс.сдвиг');
let worst = 0, worstLabel = '';
for (const dir of dirs) {
	let parsed;
	try { parsed = parseGLTFFiles(readDir(dir), { scale: 16, uvWidth: 1, uvHeight: 1 }); } catch { continue; }

	let cubes = 0, upright = 0, turned = 0, maxShift = 0;
	// Симметричные детали (два глаза, две руки) имеют одинаковый размер.
	// Если одна привязалась, а вторая нет, модель становится асимметричной —
	// именно так пропал один зрачок, пока привязка зависела от поворота.
	const byShape = new Map();
	let distorted = 0;
	for (const obj of parsed.objects) {
		for (const faces of splitComponents(obj.faces)) {
			const sol = solveBox(faces);
			if (sol.error) continue;
			cubes++;
			const basis = [sol.vx, sol.vy, sol.vz];
			if (isIdentityBasis(sol)) upright++; else turned++;

			const half = sol.size.map(v => Math.abs(v) / 2);
			const from = sol.center.map((c, i) => c - half[i]);
			const to = sol.center.map((c, i) => c + half[i]);
			const place = placeOf(sol);

			const before = corners(from, to, sol.center, basis);
			const after = corners(place(from), place(to), place(sol.center), basis);
			for (let i = 0; i < before.length; i++) {
				maxShift = Math.max(maxShift, Math.hypot(
					after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]));
			}

			// Размер до и после. Порог — абсолютный: плагин обещает двигать
			// координату не дальше SNAP_TOLERANCE (0.02), значит размер может
			// измениться максимум на две такие подвижки. Проценты тут не годятся:
			// у детали толщиной 0.001 любое шевеление — это сотни процентов,
			// хотя глазу оно недоступно.
			const LIMIT = 0.041;
			const sizeBefore = sol.size.map(v => Math.abs(v));
			const placedFrom = place(from), placedTo = place(to);
			const sizeAfter = [0, 1, 2].map(i => Math.abs(placedTo[i] - placedFrom[i]));
			for (let i = 0; i < 3; i++) {
				if (Math.abs(sizeAfter[i] - sizeBefore[i]) > LIMIT) distorted++;
			}
			// Симметричные детали должны остаться одинаковыми с точностью до
			// той же величины: если одна поехала, а вторая нет, это видно.
			const key = sizeBefore.map(v => v.toFixed(4)).join(",");
			if (!byShape.has(key)) byShape.set(key, []);
			byShape.get(key).push(sizeAfter);
		}
	}
	const asym = [...byShape.values()].filter(list => {
		for (let i = 1; i < list.length; i++) {
			for (let k = 0; k < 3; k++) {
				if (Math.abs(list[i][k] - list[0][k]) > 0.041) return true;
			}
		}
		return false;
	}).length;
	if (asym) { bad++; console.log(`  ❌ одинаковые детали разошлись в размере: ${asym} групп`); }
	if (distorted) { bad++; console.log(`  ❌ форма поехала у ${distorted} осей`); }
	if (!cubes) continue;
	const label = path.relative(root, dir).replace(/[/\\]source$/, '');
	if (maxShift > worst) { worst = maxShift; worstLabel = label; }
	console.log(`  ${label.slice(0, 36).padEnd(38)} ${String(cubes).padStart(5)} `
		+ `${String(upright).padStart(7)} ${String(turned).padStart(6)} ${maxShift.toFixed(4).padStart(12)}`);
}

console.log('');
// Половина шага сетки по каждой оси даёт в пространстве 0.125·√3 ≈ 0.2165.
ok(worst <= 0.2166, `вершины нигде не уехали дальше половины шага сетки `
	+ `(максимум ${worst.toFixed(4)} px${worstLabel ? ', ' + worstLabel : ''})`);

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ ПРИВЯЗКА К СЕТКЕ РАБОТАЕТ\n');
process.exit(bad ? 1 : 0);

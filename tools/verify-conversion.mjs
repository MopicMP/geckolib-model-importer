/**
 * Прогоняет ядро плагина (solveBox) по настоящему OBJ, без запуска Blockbench.
 * Импортирует функцию из plugin/geckolib_model_importer.js — не копию.
 *
 * Запуск: node tools/verify-conversion.mjs model/model.obj
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox } = require('../plugin/geckolib_model_importer.js');

const file = process.argv[2] ?? 'model/model.obj';
const TEX = 128;   // размер текстуры проекта

// ------------------------------------------------------------- парсинг OBJ

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
		if (!current) objects.push(current = { name: '<unnamed>', faces: [] });
		const corners = p.slice(1).map(tok => {
			const [v, t] = tok.split('/');
			return { v: +v - 1, t: t ? +t - 1 : -1 };
		});
		current.faces.push({
			positions: corners.map(c => positions[c.v]),
			// в Blockbench UV в пикселях текстуры и ось V смотрит вниз, в OBJ — наоборот
			uvs: corners.map(c => c.t < 0 ? null : [uvs[c.t][0] * TEX, (1 - uvs[c.t][1]) * TEX]),
		});
	}
}

// -------------------------------------------------------------- проверки

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dist = (a, b) => Math.hypot(...sub(a, b));

let okSolve = 0, okShape = 0, totalViolations = 0, emptyFaces = 0, uvFaces = 0;
const problems = [], worstShape = [], flips = {};

for (const obj of objects) {
	const sol = solveBox(obj.faces);
	if (sol.error) { problems.push(`${obj.name}: ${sol.error}`); continue; }
	okSolve++;

	// --- форма восстанавливается точно? ---
	// куб задаётся как center ± size/2 с поворотом вокруг center.
	// Разворачиваем обратно в 8 углов и сравниваем с исходными вершинами.
	const half = mul(sol.size, 0.5);
	const corners = [];
	for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
		corners.push(add(sol.center, add(add(
			mul(sol.vx, sx * half[0]),
			mul(sol.vy, sy * half[1])),
			mul(sol.vz, sz * half[2]))));
	}
	const uniq = new Map();
	for (const f of obj.faces) for (const p of f.positions) uniq.set(p.join(','), p);

	let worst = 0;
	for (const p of uniq.values()) worst = Math.max(worst, Math.min(...corners.map(c => dist(p, c))));
	const span = Math.max(...sol.size) || 1;
	worstShape.push(worst / span);
	if (worst <= span * 1e-5) okShape++;
	else problems.push(`${obj.name}: форма расходится на ${worst.toExponential(2)}`);

	totalViolations += sol.violations;
	if (sol.violations) problems.push(`${obj.name}: ${sol.violations} несостыковок UV`);
	emptyFaces += sol.emptyFaces.length;
	uvFaces += Object.keys(sol.faceUV).length;

	// Косвенная проверка ЗНАКОВ в FACE_DIRS.
	// Перевёрнутый прямоугольник (x1>x2) Blockbench читает как отражение. Изредка
	// это законно, но если у какого-то направления перевёрнуты почти все грани —
	// значит знак в FACE_DIRS для него выбран неверно.
	// Считаем только по слабо повёрнутым кубам: у сильно повёрнутых выбор одного
	// из 24 базисов неоднозначен (несколько дают ноль нарушений), и отражение
	// там — следствие выбора базиса, а не ошибки в FACE_DIRS.
	const trace = sol.vx[0] + sol.vy[1] + sol.vz[2];
	const angle = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180 / Math.PI;
	if (angle > 10) continue;

	for (const [name, uv] of Object.entries(sol.faceUV)) {
		const f = flips[name] ??= { u: 0, v: 0, total: 0 };
		f.total++;
		if (uv[0] > uv[2]) f.u++;
		if (uv[1] > uv[3]) f.v++;
	}
}

// --------------------------------------------------------------- отчёт

const n = objects.length;
console.log(`\n=== ПРОВЕРКА ЯДРА КОНВЕРТЕРА (${n} объектов) ===\n`);
console.log(`Распознано как ящик   : ${okSolve}/${n}`);
console.log(`Форма восстановлена   : ${okShape}/${n} точно`);
console.log(`Граней с UV           : ${uvFaces}`);
console.log(`Граней без исходника  : ${emptyFaces} (будут скрыты)`);
console.log(`UV требуют поворота   : ${totalViolations}`);

if (worstShape.length) {
	worstShape.sort((a, b) => a - b);
	console.log(`\nХудшее относительное отклонение формы: ${worstShape[worstShape.length - 1].toExponential(2)}`);
}

console.log(`\nОтражённые UV по граням (высокий % = неверный знак в FACE_DIRS):`);
for (const [name, f] of Object.entries(flips)) {
	const pu = ((f.u / f.total) * 100).toFixed(0), pv = ((f.v / f.total) * 100).toFixed(0);
	const flag = (f.u / f.total > 0.9 || f.v / f.total > 0.9) ? '  ← подозрительно' : '';
	console.log(`  ${name.padEnd(6)} u:${pu.padStart(3)}%  v:${pv.padStart(3)}%  из ${f.total}${flag}`);
}

if (problems.length) {
	console.log(`\nПроблемы (${problems.length}):`);
	for (const p of problems.slice(0, 15)) console.log('  ' + p);
	if (problems.length > 15) console.log(`  …и ещё ${problems.length - 15}`);
}

const pass = okSolve === n && okShape === n && totalViolations === 0;
console.log(`\n${pass ? '✅ ВСЁ ЧИСТО — конвертация без потерь' : '❌ ЕСТЬ ПРОБЛЕМЫ, см. выше'}\n`);
process.exit(pass ? 0 : 1);

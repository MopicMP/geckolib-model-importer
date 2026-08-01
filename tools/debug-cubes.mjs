/**
 * Разбор конкретных кубов: углы Эйлера и раскладка UV по граням.
 *
 * Запуск: node tools/debug-cubes.mjs model/model.obj 40,46,49 0,2,37
 *   первый список — «группа A», второй — «группа B» (можно опустить)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox, FACE_NAMES } = require('../plugin/geckolib_model_importer.js');

const file = process.argv[2] ?? 'model/model.obj';
const groupA = (process.argv[3] ?? '').split(',').filter(Boolean);
const groupB = (process.argv[4] ?? '').split(',').filter(Boolean);

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
		const c = p.slice(1).map(tok => {
			const [v, t] = tok.split('/');
			return { v: +v - 1, t: t ? +t - 1 : -1 };
		});
		current.faces.push({
			positions: c.map(x => positions[x.v]),
			uvs: c.map(x => x.t < 0 ? null : [uvs[x.t][0] * TEX, (1 - uvs[x.t][1]) * TEX]),
		});
	}
}

// ------------------------------------------------- разложение углов Эйлера
// Матрица: столбцы — базисные векторы. Формулы как в THREE.Euler.

const clamp = v => Math.min(1, Math.max(-1, v));
const deg = r => +(r * 180 / Math.PI).toFixed(2);

function eulerXYZ(vx, vy, vz) {
	const m11 = vx[0], m12 = vy[0], m13 = vz[0];
	const m22 = vy[1], m23 = vz[1];
	const m32 = vy[2], m33 = vz[2];
	const y = Math.asin(clamp(m13));
	if (Math.abs(m13) < 0.9999999) return [deg(Math.atan2(-m23, m33)), deg(y), deg(Math.atan2(-m12, m11))];
	return [deg(Math.atan2(m32, m22)), deg(y), 0];
}

function eulerZYX(vx, vy, vz) {
	const m11 = vx[0], m21 = vx[1], m31 = vx[2];
	const m12 = vy[0], m22 = vy[1], m32 = vy[2];
	const m33 = vz[2];
	const y = Math.asin(-clamp(m31));
	if (Math.abs(m31) < 0.9999999) return [deg(Math.atan2(m32, m33)), deg(y), deg(Math.atan2(m21, m11))];
	return [0, deg(y), deg(Math.atan2(-m12, m22))];
}

const nameOf = i => i === 0 ? 'cube' : `cube_${i}`;
const byName = new Map(objects.map(o => [o.name, o]));
const solved = new Map();
for (const o of objects) {
	const s = solveBox(o.faces);
	if (!s.error) solved.set(o.name, s);
}

// ------------------------------------- сколько осей задействовано в повороте

let multi = 0, single = 0, zero = 0;
const multiNames = [];
for (const [name, s] of solved) {
	const e = eulerXYZ(s.vx, s.vy, s.vz);
	const n = e.filter(a => Math.abs(a) > 0.01).length;
	if (n === 0) zero++;
	else if (n === 1) single++;
	else { multi++; multiNames.push(name); }
}
console.log(`\n=== Сколько осей в повороте (XYZ) ===`);
console.log(`  без поворота     : ${zero}`);
console.log(`  одна ось         : ${single}`);
console.log(`  две и более осей : ${multi}`);
console.log(`\nКубы с поворотом по нескольким осям (${multi}):`);
console.log('  ' + multiNames.join(', '));

// -------------------------------------------------------- разбор группы A

if (groupA.length) {
	const names = groupA.map(n => nameOf(+n));
	console.log(`\n=== ГРУППА A — углы Эйлера ===`);
	console.log(`(если порядок сборки в Blockbench другой, многоосевые собираются неверно)\n`);
	let allMulti = true;
	for (const name of names) {
		const s = solved.get(name);
		if (!s) { console.log(`  ${name}: не решён`); continue; }
		const a = eulerXYZ(s.vx, s.vy, s.vz);
		const b = eulerZYX(s.vx, s.vy, s.vz);
		const axes = a.filter(v => Math.abs(v) > 0.01).length;
		if (axes < 2) allMulti = false;
		console.log(`  ${name.padEnd(10)} осей:${axes}  XYZ=[${a.join(', ')}]  ZYX=[${b.join(', ')}]`);
	}
	console.log(`\n  Все ли многоосевые? ${allMulti ? 'ДА — гипотеза о порядке Эйлера подтверждается' : 'НЕТ — дело не только в Эйлере'}`);

	const inA = new Set(names);
	const extra = multiNames.filter(n => !inA.has(n));
	console.log(`  Многоосевых вне группы A: ${extra.length}${extra.length ? ' → ' + extra.join(', ') : ''}`);
}

// -------------------------------------------------------- разбор группы B

if (groupB.length) {
	console.log(`\n=== ГРУППА B — раскладка UV по граням ===`);
	console.log(`(m = отражено по обеим осям = поворот текстуры на 180°)\n`);
	for (const n of groupB) {
		const name = nameOf(+n);
		const s = solved.get(name);
		if (!s) { console.log(`  ${name}: не решён`); continue; }
		const parts = [];
		for (const f of FACE_NAMES) {
			const uv = s.faceUV[f];
			if (!uv) { parts.push(`${f}:—`); continue; }
			const fu = uv[0] > uv[2], fv = uv[1] > uv[3];
			parts.push(`${f}:${fu && fv ? '180°' : fu ? 'u' : fv ? 'v' : '.'}`);
		}
		const e = eulerXYZ(s.vx, s.vy, s.vz);
		console.log(`  ${name.padEnd(10)} ${parts.join('  ')}   поворот=[${e.join(', ')}]`);
	}
}
console.log('');

/**
 * Проверяет математику анимаций БЕЗ Blockbench.
 *
 * Собирает позу так, как её соберёт Blockbench из наших кадров, и сравнивает
 * с истинной позой из glTF. Всё, что нужно, — чистая арифметика, поэтому
 * ошибку видно здесь, а не после очередного круга «импортируй и посмотри».
 *
 * Модель в Blockbench: кости стоят с нулевым поворотом, поза покоя запечена
 * в мировые координаты, а кадр задаёт смещение. Поворот кости применяется
 * ВОКРУГ ЕЁ ТОЧКИ ПРИВЯЗКИ, вложенные кости перемножаются.
 *
 * Запуск: node tools/verify-animation.mjs [имя анимации] [время]
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../plugin/geckolib_model_importer.js');
const { matMul, matFromTRS, matApply, matIdentity, boneDeltaRotation, boneDeltaPosition } = M;

const wantAnim = process.argv[2] || null;
const wantTime = process.argv[3] !== undefined ? +process.argv[3] : 0;

const parsed = M.parseGLTFFiles(
	{ 'm.gltf': new Uint8Array(fs.readFileSync('model(gltf)/source/model.gltf')) },
	{ scale: 16, uvWidth: 128, uvHeight: 128 });

const byIdx = new Map(parsed.hierarchy.map(h => [h.index, h]));
const chainOf = h => { const c = []; for (let n = h; n; n = n.parent >= 0 ? byIdx.get(n.parent) : null) c.unshift(n); return c; };

/** Значение канала в момент t (линейная интерполяция, как в glTF). */
function sample(ch, t) {
	const { times, values } = ch;
	if (t <= times[0]) return values[0];
	if (t >= times[times.length - 1]) return values[values.length - 1];
	let i = 0;
	while (i + 1 < times.length && times[i + 1] < t) i++;
	const k = (t - times[i]) / (times[i + 1] - times[i]);
	const a = values[i], b = values[i + 1];
	const out = a.map((v, j) => v + (b[j] - v) * k);
	if (ch.path === 'rotation') {   // кватернионы нормируем
		const len = Math.hypot(...out);
		return out.map(v => v / len);
	}
	return out;
}

/** Матрица поворота вокруг точки: T(p) · R(q) · T(−p). */
function rotateAround(pivot, q) {
	const T = p => matFromTRS(p, [0, 0, 0, 1], [1, 1, 1]);
	return matMul(matMul(T(pivot), matFromTRS([0, 0, 0], q, [1, 1, 1])), T(pivot.map(v => -v)));
}

const MODES = ['local', 'model', 'absolute', 'skip', 'rt'];
// Как Blockbench складывает сдвиг с поворотом кости, мы не знаем:
// 'TR' — сдвиг снаружи (как локальная матрица THREE), 'RT' — сдвиг внутри
// поворота. От этого зависит, что именно надо записывать.
const COMPOSE = ['TR', 'RT'];
const ORDERS = [false, true];   // preMultiply

// Сводим по ВСЕМ анимациям и нескольким моментам времени: на одной анимации
// в одной точке нужную комбинацию не отличить — половина вариантов даёт ноль
// по совпадению.
const TIMES = [0, 0.17, 0.33, 0.5, 0.75, 1.0];
const totals = new Map();

for (const anim of parsed.animations) {
	if (wantAnim && anim.name !== wantAnim) continue;
	for (const time of TIMES) {
		const at = {};
		for (const ch of anim.channels) (at[ch.node] = at[ch.node] || {})[ch.path] = sample(ch, time * Math.max(anim.length, 1e-6));

		const truth = {};
		for (const h of parsed.hierarchy) {
			let m = matIdentity();
			for (const n of chainOf(h)) {
				const o = at[n.index] || {};
				m = matMul(m, matFromTRS(o.translation || n.rest.translation, o.rotation || n.rest.rotation, n.rest.scale));
			}
			truth[h.index] = matApply(m, [0, 0, 0]).map(v => v * 16);
		}

		for (const compose of COMPOSE) {
			for (const preMul of ORDERS) {
				for (const mode of MODES) {
					const key = `${compose} ${mode.padEnd(9)} ${preMul ? 'R0inv*R' : 'R*R0inv'}`;
					let worst = totals.get(key) || { worst: 0, where: '' };
					for (const h of parsed.hierarchy) {
						let m = matIdentity();
						for (const n of chainOf(h)) {
							const o = at[n.index];
							if (!o) continue;
							const dRot = o.rotation ? boneDeltaRotation(n.rest, n.parentQuat, o.rotation, preMul) : [0, 0, 0, 1];
							const T = o.translation && mode !== 'skip'
								? matFromTRS(boneDeltaPosition(n.rest, n.parentQuat, o.translation, mode, dRot), [0, 0, 0, 1], [1, 1, 1])
								: matIdentity();
							const R = o.rotation ? rotateAround(n.pivot, dRot) : matIdentity();
							m = matMul(m, compose === 'TR' ? matMul(T, R) : matMul(R, T));
						}
						const got = matApply(m, h.pivot), want = truth[h.index];
						const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
						if (err > worst.worst) worst = { worst: err, where: `${anim.name}/${h.name}` };
					}
					totals.set(key, worst);
				}
			}
		}
	}
}

const rows = [...totals.entries()].sort((a, b) => a[1].worst - b[1].worst);
console.log('');
console.log('Сводка по всем анимациям и 6 моментам времени:');
console.log('');
console.log('сборка режим     формула      худший промах  где');
for (const [key, v] of rows) {
	const tag = v.worst < 0.01 ? '✅' : v.worst < 1 ? '  ' : '❌';
	console.log(`${tag} ${key}  ${v.worst.toFixed(3).padStart(10)} px  ${v.where}`);
}
console.log('');

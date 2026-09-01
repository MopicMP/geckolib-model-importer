/**
 * Проверка сборки .cpmproject: читаем свой же вывод правилами мода.
 *
 * Blockbench тут запустить нельзя, а проверять руками в игре — долго. Зато
 * правила формата целиком лежат в CustomPlayerModels/.../project/loaders/*V1.java
 * и в BoxRender.java, и по ним пишется независимая проверка.
 *
 * Проверяем три вещи, от дешёвой к дорогой:
 *   1. структура — те поля и типы, которые читает ElementsLoaderV1;
 *   2. пределы — углы в 0..360, UV целые, число кубов против MAX_CUBE_COUNT;
 *   3. геометрию — прогоняем дерево тем же преобразованием, что и рендер CPM
 *      (сдвиг pos, поворот, сдвиг offset, ящик size), и сверяем восемь углов
 *      каждого ящика с исходником из Blockbench.
 *
 * Третья и есть настоящая: она ловит перепутанные оси, знаки и порядок углов —
 * ровно то, на чём ломается перенос.
 *
 *   node tools/verify-cpm.mjs "model(gltf)/source/model.gltf"
 *   node tools/verify-cpm.mjs "model(gltf)/source/model.gltf" --write out.cpmproject
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const plugin = require('../plugin/geckolib_model_importer.js');
const {
	parseGLTFFiles, solveBox, boxFromBounds, isDegenerate, splitComponents,
	placeCoords, buildCPMFiles, cpmAutoAssign, cpmUVScale, cpmPoint,
	CPM_PARTS, CPM_PART_NAMES, FACE_NAMES,
} = plugin;

const args = process.argv.slice(2);
const gltfPath = args.find(a => !a.startsWith('--')) || 'model(gltf)/source/model.gltf';
const writeAt = args.includes('--write') ? args[args.indexOf('--write') + 1] : null;
const FPS = Number(args.includes("--fps") ? args[args.indexOf("--fps") + 1] : 0) || 12;
const SCALE = Number(args.includes('--scale') ? args[args.indexOf('--scale') + 1] : 0) || null;

// ------------------------------------------------------------------ загрузка

if (!fs.existsSync(gltfPath)) {
	console.error(`нет файла: ${gltfPath}`);
	process.exit(2);
}

const dir = path.dirname(gltfPath);
const files = {};
files[path.basename(gltfPath)] = new Uint8Array(fs.readFileSync(gltfPath));
// glTF ссылается на соседние файлы (.bin, картинки) относительными путями
const gltfJson = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
for (const ref of [...(gltfJson.buffers || []), ...(gltfJson.images || [])]) {
	if (!ref.uri || ref.uri.startsWith('data:')) continue;
	const p = path.join(dir, decodeURIComponent(ref.uri));
	if (fs.existsSync(p)) files[ref.uri] = new Uint8Array(fs.readFileSync(p));
	else {
		const alt = path.join(dir, '..', decodeURIComponent(ref.uri));
		if (fs.existsSync(alt)) files[ref.uri] = new Uint8Array(fs.readFileSync(alt));
	}
}

// Масштаб: как в импорте — по габаритам, если не задан руками.
const probe = parseGLTFFiles(files, { scale: 1, uvWidth: 1, uvHeight: 1, rotate: [0, 0, 0] });

// Текстура берётся из разбора, а не с диска: в этой модели она вшита в glTF
// как data-URI, и поиск по имени файла её просто не находит.
let texW = 64, texH = 64, skinBytes = null;
for (const img of probe.images) {
	const s = plugin.imageSize(img.bytes);
	if (!s || img.role === 'aux') continue;
	texW = s.width; texH = s.height; skinBytes = img.bytes;
	break;
}
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const o of probe.objects) for (const f of o.faces) for (const q of f.positions) {
	for (let a = 0; a < 3; a++) { if (q[a] < lo[a]) lo[a] = q[a]; if (q[a] > hi[a]) hi[a] = q[a]; }
}
const heightUnits = hi[1] - lo[1] || 1;
// CPM меряет в пикселях игрока: рост 32 px. Это и есть значение по умолчанию
// для отдельного ползунка масштаба у ветки CPM.
const scale = SCALE || 32 / heightUnits;
// Ноги игрока стоят на y = 0, поэтому низ модели опускаем на ноль, а X и Z центрируем.
const offset = [
	-((lo[0] + hi[0]) / 2) * scale,
	-lo[1] * scale,
	-((lo[2] + hi[2]) / 2) * scale,
];

const parsed = parseGLTFFiles(files, { scale, offset, rotate: [0, 0, 0], uvWidth: texW, uvHeight: texH });

// Слитые меши разбираем на компоненты — как в импорте.
const split = [];
for (const obj of parsed.objects) {
	const parts = splitComponents(obj.faces);
	parts.forEach((faces, i) => split.push({
		...obj,
		name: parts.length > 1 ? `${obj.name}_${i + 1}` : obj.name,
		faces,
	}));
}

const cubes = [];
let approximated = 0;
for (const obj of split) {
	if (isDegenerate(obj.faces)) continue;
	let sol = solveBox(obj.faces);
	if (sol.error) {
		sol = boxFromBounds(obj.faces);
		if (!sol) continue;
		approximated++;
	}
	cubes.push({ name: obj.name, node: obj.node, sol, inflate: 0 });
}

// ------------------------------------------------------------------- сборка

const assign = cpmAutoAssign(parsed.hierarchy);
const uv = cpmUVScale(cubes, 16, Math.max(texW, texH));
// Узлы, которые двигает хоть одна анимация: их схлопывать нельзя, иначе
// анимации нечего будет поворачивать.
const animated = new Set();
for (const a of parsed.animations) for (const ch of a.channels) animated.add(ch.node);

const poses = {};
for (const a of parsed.animations) poses[a.name] = plugin.cpmAutoPose(a.name);

// Совмещение скелета с игроцким. Без него модель, собранная не вокруг центра,
// в покое выглядит правильно, а при первом же движении конечности выворачивает.
const align = plugin.cpmAlignOffset(parsed.hierarchy, assign, 1);

const built = buildCPMFiles({
	align,
	// Голову ведёт сама модель: у неё есть свои анимации, а ванильный поворот
	// по камере накладывался бы поверх и отрывал голову от тела при наклоне.
	stopVanillaAnim: { head: true },
	hierarchy: parsed.hierarchy,
	cubes,
	assign,
	keepNodes: animated,
	animations: parsed.animations,
	poses,
	fps: FPS,
	gltfScale: scale,
	uvMul: uv.mul,
	texWidth: texW,
	texHeight: texH,
	uvWidth: texW * uv.mul,
	uvHeight: texH * uv.mul,
	skin: skinBytes,
	name: path.basename(gltfPath),
});

// ---------------------------------------------------------------- проверки

const problems = [];
const notes = [];
const fail = m => problems.push(m);

// 1. Структура: поля и типы, которые читает ElementsLoaderV1.loadElement.
const NUM_FIELDS = ['textureSize', 'u', 'v', 'mcScale', 'nameColor'];
const BOOL_FIELDS = ['show', 'texture', 'mirror', 'glow', 'recolor', 'hidden', 'singleTex', 'extrude', 'locked'];
const VEC_FIELDS = ['offset', 'pos', 'rotation', 'size', 'rscale', 'scale'];
const config = built.config;

if (config.version !== 1) fail(`version = ${config.version}, загрузчик ищет 1`);
if (!Array.isArray(config.elements)) fail('elements не список');

const rootIds = config.elements.map(e => e.id);
for (const p of CPM_PART_NAMES) {
	if (!rootIds.includes(p)) fail(`нет корня ${p}`);
}
for (const e of config.elements) {
	// ElementsLoaderV1 ищет корень по имени части игрока; чужое имя — это ровно
	// то, на чём споткнулся официальный плагин (Unknown root group).
	if (!CPM_PART_NAMES.includes(e.id) && !e.customPart) fail(`неизвестный корень: ${e.id}`);
}

let elemCount = 0, boxCount = 0, uvFaces = 0;
const walk = (list, depth) => {
	for (const el of list || []) {
		elemCount++;
		if (typeof el.name !== 'string') fail(`${el.name}: name не строка`);
		for (const f of NUM_FIELDS) if (typeof el[f] !== 'number') fail(`${el.name}: ${f} не число`);
		for (const f of BOOL_FIELDS) if (typeof el[f] !== 'boolean') fail(`${el.name}: ${f} не булево`);
		for (const f of VEC_FIELDS) {
			const v = el[f];
			if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
				fail(`${el.name}: ${f} не вектор`);
			}
		}
		// Integer.parseUnsignedInt(color, 16) упадёт на чём угодно другом
		if (!/^[0-9a-fA-F]{1,8}$/.test(String(el.color))) fail(`${el.name}: color = ${el.color} не шестнадцатеричная строка`);
		for (const a of ['x', 'y', 'z']) {
			const r = el.rotation[a];
			if (!(r >= 0 && r < 360)) fail(`${el.name}: rotation.${a} = ${r} вне 0..360 — writeAngle обрежет в ноль`);
			if (!(el.size[a] >= 0)) fail(`${el.name}: size.${a} отрицательный`);
		}
		if (el.size.x || el.size.y || el.size.z) boxCount++;
		if (el.faceUV) {
			for (const [d, f] of Object.entries(el.faceUV)) {
				uvFaces++;
				for (const k of ['sx', 'sy', 'ex', 'ey']) {
					if (!Number.isInteger(f[k])) fail(`${el.name}/${d}: ${k} = ${f[k]} не целое`);
				}
				if (!['0', '90', '180', '270'].includes(f.rot)) fail(`${el.name}/${d}: rot = ${f.rot}`);
			}
		}
		walk(el.children, depth + 1);
	}
};
for (const root of config.elements) walk(root.children, 0);

// 2. Пределы зрителя. Не ошибка формата, но модель просто не покажут.
if (boxCount > 256) notes.push(`кубов ${boxCount} — больше дефолтного MAX_CUBE_COUNT=256, увидят только друзья`);
if (Math.max(texW, texH) > 256) notes.push(`картинка ${texW}×${texH} — больше дефолтного MAX_TEX_SHEET_SIZE=256`);

// 3. Геометрия. Повторяем преобразование рендера CPM и сверяем углы ящиков.
const rad = d => d * Math.PI / 180;
function rotZYX(r) {
	const [x, y, z] = [rad(r.x), rad(r.y), rad(r.z)];
	const cx = Math.cos(x), sx = Math.sin(x);
	const cy = Math.cos(y), sy = Math.sin(y);
	const cz = Math.cos(z), sz = Math.sin(z);
	const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
	const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
	const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
	return matMul3(Rz, matMul3(Ry, Rx));
}
function matMul3(a, b) {
	const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
		o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
	}
	return o;
}
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function apply3(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

// Ожидаемое: углы ящика в Blockbench, переведённые в координаты CPM.
// Сопоставлять по имени нельзя: в этой модели 108 мешей и почти все зовутся
// «cube». Поэтому ящики сводятся по центру — они стоят в разных местах.
const expected = [];
for (const c of cubes) {
	const place = placeCoords(c.sol);
	const half = c.sol.size.map(v => Math.abs(v) / 2);
	const from = place(c.sol.center.map((v, i) => v - half[i]));
	const to = place(c.sol.center.map((v, i) => v + half[i]));
	const center = from.map((v, i) => (v + to[i]) / 2);
	const size = from.map((v, i) => Math.abs(to[i] - v));
	const pts = [];
	for (const sxx of [-1, 1]) for (const syy of [-1, 1]) for (const szz of [-1, 1]) {
		const d = [sxx * size[0] / 2, syy * size[1] / 2, szz * size[2] / 2];
		const w = [
			center[0] + c.sol.vx[0] * d[0] + c.sol.vy[0] * d[1] + c.sol.vz[0] * d[2],
			center[1] + c.sol.vx[1] * d[0] + c.sol.vy[1] * d[1] + c.sol.vz[1] * d[2],
			center[2] + c.sol.vx[2] * d[0] + c.sol.vy[2] * d[1] + c.sol.vz[2] * d[2],
		];
		// ожидание тоже сдвигаем: совмещение переносит модель целиком
		pts.push(add3(cpmPoint(w), align));
	}
	expected.push({ name: c.name, pts });
}

// Полученное: прогон дерева тем же путём, что и рендер.
function collectBoxes(cfg) {
	const out = [];
	const render = (list, base, rot) => {
		for (const el of list || []) {
			const p = apply3(rot, [el.pos.x, el.pos.y, el.pos.z]);
			const origin = [base[0] + p[0], base[1] + p[1], base[2] + p[2]];
			const R = matMul3(rot, rotZYX(el.rotation));
			if (el.size.x || el.size.y || el.size.z) {
				const pts = [];
				for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
					const local = [
						el.offset.x + i * el.size.x,
						el.offset.y + j * el.size.y,
						el.offset.z + k * el.size.z,
					];
					const w = apply3(R, local);
					pts.push([origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]]);
				}
				out.push({ name: el.name, pts });
			}
			render(el.children, origin, R);
		}
	};
	for (const root of cfg.elements) {
		const pivot = CPM_PARTS[root.id];
		if (!pivot) continue;
		const base = [pivot[0] + root.pos.x, pivot[1] + root.pos.y, pivot[2] + root.pos.z];
		render(root.children, base, rotZYX(root.rotation));
	}
	return out;
}
const got = collectBoxes(config);

// Ползунок масштаба — отдельный множитель поверх разбора. Проверяется на
// итоговой геометрии, а не на полях элементов: часть костей меряется от
// НЕПОДВИЖНОГО пивота игрока, поэтому их pos удвоиться и не должен. Расти
// модель обязана от земли, то есть от точки y = 24 в координатах CPM.
{
	// без совмещения с обеих сторон: проверяем однородность масштаба, а сдвиг
	// зависит от него нелинейно и к делу отношения не имеет
	const plain = k => buildCPMFiles({
		hierarchy: parsed.hierarchy, cubes, assign, keepNodes: animated, scale: k,
		align: [0, 0, 0], uvMul: uv.mul, texWidth: texW, texHeight: texH,
		uvWidth: texW * uv.mul, uvHeight: texH * uv.mul,
	}).config;
	const one = collectBoxes(plain(1));
	const big = collectBoxes(plain(2));
	let bad = 0, worstK = 0;
	if (big.length !== one.length) bad++;
	else for (let i = 0; i < one.length; i++) {
		for (let v = 0; v < 8; v++) {
			// в исходные координаты: там масштабирование однородно относительно нуля
			const a = [-one[i].pts[v][0], 24 - one[i].pts[v][1], one[i].pts[v][2]];
			const b = [-big[i].pts[v][0], 24 - big[i].pts[v][1], big[i].pts[v][2]];
			for (let ax = 0; ax < 3; ax++) worstK = Math.max(worstK, Math.abs(b[ax] - a[ax] * 2));
		}
	}
	if (bad || worstK > 0.01) fail(`масштаб не однороден: расхождение ${worstK.toFixed(4)} px при k=2`);
	notes.push(`масштаб однороден: при k=2 отклонение ${worstK.toExponential(2)} px`);
}

// Углы — множество, порядок обхода у нас и у рендера разный.
function worstMismatch(a, b) {
	let worst = 0;
	for (const p of a) {
		let best = Infinity;
		for (const q of b) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
		worst = Math.max(worst, best);
	}
	return worst;
}

const centroid = pts => pts.reduce((a, p) => [a[0] + p[0] / 8, a[1] + p[1] / 8, a[2] + p[2] / 8], [0, 0, 0]);
for (const e of [...expected, ...got]) e.mid = centroid(e.pts);

let checked = 0, worstAll = 0, worstName = '';
const missing = [];
if (expected.length !== got.length) {
	fail(`ящиков в дереве CPM ${got.length}, а исходных ${expected.length}`);
}
const taken = new Array(got.length).fill(false);
for (const e of expected) {
	let best = -1, bestD = Infinity;
	for (let i = 0; i < got.length; i++) {
		if (taken[i]) continue;
		const d = Math.hypot(e.mid[0] - got[i].mid[0], e.mid[1] - got[i].mid[1], e.mid[2] - got[i].mid[2]);
		if (d < bestD) { bestD = d; best = i; }
	}
	if (best < 0) { missing.push(e.name); continue; }
	taken[best] = true;
	const d = worstMismatch(e.pts, got[best].pts);
	checked++;
	if (d > worstAll) { worstAll = d; worstName = e.name; }
}
if (missing.length) fail(`не нашлись в дереве CPM: ${missing.length} (${missing.slice(0, 5).join(', ')})`);
// Допуск — округление, которое мы сами вносим: pos и offset до 4 знаков,
// углы до сотой градуса. На плече в 20 px сотая градуса даёт ~0.004 px.
const TOL = 0.02;
if (worstAll > TOL) fail(`геометрия разошлась: до ${worstAll.toFixed(4)} px (${worstName})`);

// 4. Анимации. Собираем позу из наших кадров так, как её соберёт CPM, и
// сравниваем с истинной позой из glTF — той же, что в tools/verify-animation.mjs.
// Это единственная проверка, которая ловит перепутанные оси в поворотах кадра:
// сами по себе кадры выглядят правдоподобно при любом знаке.
const animFiles = Object.keys(built.files).filter(n => n.startsWith('animations/'));
let animChecked = 0, animWorst = 0, animWhere = '';
{
	const byIdx = new Map(parsed.hierarchy.map(h => [h.index, h]));
	const chainOf = h => { const c = []; for (let n = h; n; n = n.parent >= 0 ? byIdx.get(n.parent) : null) c.unshift(n); return c; };
	// куда попал элемент каждой кости — по storeID
	const elemByStore = new Map();
	const walkEl = (list, part) => (list || []).forEach(e => {
		elemByStore.set(e.storeID, e);
		walkEl(e.children, part);
	});
	config.elements.forEach(r => walkEl(r.children, r.id));
	const storeOfNode = new Map();
	{
		// элементы костей идут в том же порядке, что и в дереве, поэтому ищем по имени
		// и позиции: надёжнее — сверить по storeID из сборки
		const b = plugin.buildCPMConfig({
			hierarchy: parsed.hierarchy, cubes, assign, keepNodes: animated,
			uvMul: uv.mul, scale: 1,
		});
		for (const [node, el] of Object.entries(b.elemByNode)) storeOfNode.set(Number(node), el.storeID);
	}

	for (const name of animFiles) {
		const data = JSON.parse(built.files[name]);
		const src = parsed.animations.find(a => a.name === data.name);
		if (!src || !data.frames.length) continue;

		for (let fi = 0; fi < data.frames.length; fi++) {
			const t = src.length < 1e-6 ? 0 : (fi / data.frames.length) * src.length;

			// истина: мировые позиции узлов по самому glTF
			const at = {};
			for (const ch of src.channels) (at[ch.node] = at[ch.node] || {})[ch.path] = plugin.sampleChannel(ch, t);
			const truth = {};
			for (const h of parsed.hierarchy) {
				let m = plugin.matIdentity();
				for (const n of chainOf(h)) {
					const o = at[n.index] || {};
					m = plugin.matMul(m, plugin.matFromTRS(
						o.translation || n.rest.translation,
						o.rotation || n.rest.rotation,
						n.rest.scale));
				}
				// ровно так же, как parseGLTFFiles кладёт пивоты: масштаб и сдвиг
				// центрирования, иначе «истина» отличается на постоянный вектор
				truth[h.index] = plugin.matApply(m, [0, 0, 0]).map((v, i) => v * scale + offset[i]);
			}

			// наше: та же цепочка, но собранная из кадра правилами CPM —
			// сдвиг на pos, затем поворот, и так вниз по дереву
			const frame = new Map();
			for (const c of data.frames[fi].components) frame.set(c.storeID, c);

			for (const h of parsed.hierarchy) {
				if (!at[h.index]) continue;
				const store = storeOfNode.get(h.index);
				if (store === undefined) continue;
				let base = null, rot = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
				// найти корневую часть, под которой сидит эта кость
				for (const root of config.elements) {
					const pivot = CPM_PARTS[root.id];
					const found = (function seek(list, origin, R) {
						for (const el of list || []) {
							const p = apply3(R, [el.pos.x, el.pos.y, el.pos.z]);
							// кадр подменяет pos и rotation у элементов, которые он трогает
							const f = frame.get(el.storeID);
							const usePos = f ? [f.pos.x, f.pos.y, f.pos.z] : [el.pos.x, el.pos.y, el.pos.z];
							const useRot = f ? f.rotation : el.rotation;
							const pp = apply3(R, usePos);
							const o2 = [origin[0] + pp[0], origin[1] + pp[1], origin[2] + pp[2]];
							const R2 = matMul3(R, rotZYX(useRot));
							if (el.storeID === store) return { origin: o2, R: R2 };
							const deeper = seek(el.children, o2, R2);
							if (deeper) return deeper;
							void p;
						}
						return null;
					})(root.children, [pivot[0] + root.pos.x, pivot[1] + root.pos.y, pivot[2] + root.pos.z], rot);
					if (found) { base = found.origin; break; }
				}
				if (!base) continue;
				// назад в исходные координаты, чтобы сравнить с истиной;
				// совмещение с игроцким скелетом сначала снимаем
				const got = [-(base[0] - align[0]), 24 - (base[1] - align[1]), base[2] - align[2]];
				const want = truth[h.index];
				const err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
				animChecked++;
				if (err > animWorst) { animWorst = err; animWhere = `${data.name}/${h.name} кадр ${fi}`; }
			}
		}
	}
}
// Допуск тот же по смыслу, что и у геометрии: округление кадров до 4 знаков
// и углов до сотой градуса на плече в десятки пикселей.
if (animChecked && animWorst > 0.05) fail(`поза из анимации разошлась: до ${animWorst.toFixed(4)} px (${animWhere})`);
if (!animChecked) fail('анимации не проверены: ни одной позы не собрано');

// ------------------------------------------------------------------- вывод

const usedParts = Object.entries(built.stats.parts).filter(([, n]) => n > 0);
console.log(`модель:        ${gltfPath}`);
console.log(`масштаб:       ×${scale.toFixed(3)} — рост ${(heightUnits * scale).toFixed(1)} px${SCALE ? ' (задан)' : ' (под игрока)'}`);
console.log(`кубов:         ${cubes.length}${approximated ? ` (приближено ящиком: ${approximated})` : ''}`);
console.log(`костей:        ${built.stats.bones} из ${parsed.hierarchy.length}`);
console.log(`элементов:     ${elemCount}, с геометрией ${boxCount}`);
console.log(`частей игрока: ${usedParts.map(([p, n]) => `${p}=${n}`).join(', ') || '—'}`);
console.log(`UV-сетка:      ${texW * uv.mul}×${texH * uv.mul} (×${uv.mul}) при картинке ${texW}×${texH}`
	+ (uv.exact ? ', точно' : `, промах до ${uv.worst.toFixed(3)} px`));
console.log(`граней с UV:   ${uvFaces}`);
{
	// Насколько кости сели на ванильные пивоты после совмещения. Остаток в
	// несколько пикселей неизбежен: у импортированного персонажа плечи и бёдра
	// там, где их поставил автор, а не там, где они у Minecraft.
	console.log(`совмещение:    сдвиг [${align.map(v => v.toFixed(1)).join(', ')}] px`);
	const rows = [];
	for (const h of parsed.hierarchy) {
		const part = assign[h.index];
		if (!part || !CPM_PARTS[part]) continue;
		const c = add3(cpmPoint(h.pivot), align);
		const w = CPM_PARTS[part];
		rows.push(`${h.name}→${part} ${Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2]).toFixed(1)}`);
	}
	console.log(`  остаток по костям, px: ${rows.join(', ')}`);
}
console.log(`сверено углов: ${checked} ящиков, худшее расхождение ${worstAll.toExponential(2)} px`);
console.log(`анимаций:      ${built.stats.anim.animations} из ${parsed.animations.length}, `
	+ `${built.stats.anim.frames} кадров, ${built.stats.anim.components} записей`);
console.log(`сверено поз:   ${animChecked}, худшее расхождение ${animWorst.toExponential(2)} px`
	+ (animWhere ? ` (${animWhere})` : ''));
{
	const s = built.stats.size, kb = n => (n / 1024).toFixed(1);
	console.log(`размер в игре: ~${kb(s.total)} кБ (модель ${kb(s.cubes)}, анимации ${kb(s.anim)}, `
		+ `текстура ${kb(s.texture)}) при бюджете 30 кБ на локальную .cpmmodel`);
}
for (const a of parsed.animations) {
	console.log(`  ${a.name.padEnd(16)} → ${poses[a.name] === 'gesture' ? 'жест' : 'поза ' + poses[a.name]}`);
}
for (const w of built.warnings) console.log(`  сборка: ${w}`);
for (const n of notes) console.log(`  внимание: ${n}`);

if (writeAt) {
	fs.writeFileSync(writeAt, zipStore(built.files));
	console.log(`записано:      ${writeAt}`);
}

if (problems.length) {
	console.log('');
	console.log(`ПРОВАЛ: ${problems.length}`);
	for (const p of problems.slice(0, 20)) console.log('  ' + p);
	process.exit(1);
}
console.log('');
console.log('OK');

// ------------------------------------------------------- запись .cpmproject

/**
 * ZIP со сжатием deflate — так же, как пишет сам CPM. Кадры анимаций это
 * снимки всех подвижных костей, то есть громоздкий и однообразный JSON, на
 * котором deflate и отыгрывается: без сжатия архив выходил 1.7 МБ.
 *
 * Свой писатель, а не зависимость: формат ZIP тут занимает полсотни строк,
 * а zlib уже есть в Node.
 */
function zipStore(map) {
	const enc = new TextEncoder();
	const entries = Object.entries(map).map(([name, data]) => {
		const raw = typeof data === 'string' ? Buffer.from(enc.encode(data)) : Buffer.from(data);
		const packed = zlib.deflateRawSync(raw, { level: 9 });
		// Сжатие применяется, только если оно и правда помогло: на PNG раздутый
		// результат — обычное дело.
		const useDeflate = packed.length < raw.length;
		return { name, raw, data: useDeflate ? packed : raw, method: useDeflate ? 8 : 0 };
	});
	const local = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const nameBytes = Buffer.from(e.name, 'utf8');
		// CRC считается по ИСХОДНЫМ байтам, а не по сжатым
		const crc = crc32(e.raw);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(0, 6);
		head.writeUInt16LE(e.method, 8);
		head.writeUInt16LE(0, 10);
		head.writeUInt16LE(0, 12);
		head.writeUInt32LE(crc >>> 0, 14);
		head.writeUInt32LE(e.data.length, 18);
		head.writeUInt32LE(e.raw.length, 22);
		head.writeUInt16LE(nameBytes.length, 26);
		head.writeUInt16LE(0, 28);
		local.push(head, nameBytes, e.data);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(e.method, 10);
		cen.writeUInt32LE(crc >>> 0, 16);
		cen.writeUInt32LE(e.data.length, 20);
		cen.writeUInt32LE(e.raw.length, 24);
		cen.writeUInt16LE(nameBytes.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBytes);

		offset += 30 + nameBytes.length + e.data.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBuf, end]);
}

function crc32(buf) {
	let c, table = crc32.table;
	if (!table) {
		table = crc32.table = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c;
		}
	}
	let crc = -1;
	for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
	return (crc ^ -1) >>> 0;
}

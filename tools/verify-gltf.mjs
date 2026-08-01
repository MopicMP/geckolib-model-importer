/**
 * Проверяет разбор glTF: парсит все три варианта из test-fixtures и сверяет
 * результат solveBox с эталоном, полученным напрямую из OBJ.
 *
 * Расхождений быть не должно — геометрия та же самая, меняется только упаковка.
 *
 * Запуск: node tools/verify-gltf.mjs model/model.obj
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { solveBox, parseGLTFFiles } = require('../plugin/geckolib_model_importer.js');

const src = process.argv[2] ?? 'model/model.obj';
const TEX = 128;

// ---------------------------------------------- эталон: тот же путь, что и раньше

const positions = [], uvs = [], objects = [];
let cur = null;
for (const raw of fs.readFileSync(src, 'utf8').split('\n')) {
	const l = raw.trim();
	if (!l || l[0] === '#') continue;
	const p = l.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(cur = { name: p.slice(1).join(' '), faces: [] });
	else if (p[0] === 'f') {
		const c = p.slice(1).map(t => { const [a, b] = t.split('/'); return { v: +a - 1, t: b ? +b - 1 : -1 }; });
		for (let i = 1; i + 1 < c.length; i++) {
			const tri = [c[0], c[i], c[i + 1]];
			cur.faces.push({
				// эталон приводим к тому же масштабу, что и glTF: пиксели
				positions: tri.map(x => positions[x.v].map(v => v * 16)),
				uvs: tri.map(x => x.t < 0 ? null : [uvs[x.t][0] * TEX, (1 - uvs[x.t][1]) * TEX]),
			});
		}
	}
}

const baseline = new Map();
for (const o of objects) {
	const s = solveBox(o.faces);
	if (!s.error) baseline.set(o.name, s);
}
console.log(`\nЭталон из OBJ: ${baseline.size} объектов\n`);

// ------------------------------------------------------------- сверка вариантов

function loadDir(dir) {
	const files = {};
	for (const name of fs.readdirSync(dir)) {
		files[name] = new Uint8Array(fs.readFileSync(path.join(dir, name)));
	}
	return files;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

let allOk = true;
for (const variant of ['external', 'embedded', 'glb']) {
	const dir = path.join('test-fixtures', variant);
	if (!fs.existsSync(dir)) { console.log(`${variant.padEnd(9)} — нет фикстур, пропуск`); continue; }

	let parsed;
	try {
		parsed = parseGLTFFiles(loadDir(dir), { scale: 16, uvWidth: TEX, uvHeight: TEX });
	} catch (e) {
		console.log(`${variant.padEnd(9)} ❌ разбор упал: ${e.message}`);
		allOk = false;
		continue;
	}

	let matched = 0, bad = 0;
	const problems = [];
	for (const obj of parsed.objects) {
		const want = baseline.get(obj.name);
		if (!want) { problems.push(`${obj.name}: нет в эталоне`); bad++; continue; }
		const got = solveBox(obj.faces);
		if (got.error) { problems.push(`${obj.name}: ${got.error}`); bad++; continue; }

		const span = Math.max(...want.size) || 1;
		const tol = span * 1e-3;
		let ok = got.center.every((v, i) => near(v, want.center[i], tol))
			&& got.size.every((v, i) => near(v, want.size[i], tol));
		for (const f in want.faceUV) {
			const a = want.faceUV[f], b = got.faceUV[f];
			if (!b || !a.every((v, i) => near(v, b[i], 0.01))) ok = false;
		}
		if (ok) matched++; else { bad++; problems.push(`${obj.name}: расходится с эталоном`); }
	}

	const status = bad === 0 && matched === baseline.size ? '✅' : '❌';
	if (bad) allOk = false;
	console.log(`${variant.padEnd(9)} ${status} объектов ${parsed.objects.length}, совпало ${matched}, расхождений ${bad}`
		+ (parsed.warnings.length ? `, предупреждений ${parsed.warnings.length}` : '')
		+ (parsed.images.length ? `, текстуры: ${parsed.images.map(i => i.name).join(', ')}` : ''));
	for (const p of problems.slice(0, 5)) console.log(`            ${p}`);
}

console.log(`\n${allOk ? '✅ РАЗБОР glTF СОВПАДАЕТ С ЭТАЛОНОМ' : '❌ ЕСТЬ РАСХОЖДЕНИЯ'}\n`);
process.exit(allOk ? 0 : 1);

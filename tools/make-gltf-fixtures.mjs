/**
 * Собирает из model/model.obj три варианта glTF, чтобы было на чём проверять
 * парсер: внешний .bin, base64 внутри и бинарный .glb.
 *
 * Специально раскладывает объекты по узлам с ненулевыми трансформациями —
 * иначе иерархия и матрицы узлов остались бы непроверенными.
 *
 * Запуск: node tools/make-gltf-fixtures.mjs model/model.obj
 */
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2] ?? 'model/model.obj';
const outDir = 'test-fixtures';
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- парсинг OBJ

const positions = [], uvs = [], objects = [];
let cur = null;
for (const raw of fs.readFileSync(src, 'utf8').split('\n')) {
	const l = raw.trim();
	if (!l || l[0] === '#') continue;
	const p = l.split(/\s+/);
	if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
	else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
	else if (p[0] === 'o') objects.push(cur = { name: p.slice(1).join(' '), tris: [] });
	else if (p[0] === 'f') {
		const c = p.slice(1).map(t => { const [a, b] = t.split('/'); return { v: +a - 1, t: b ? +b - 1 : -1 }; });
		for (let i = 1; i + 1 < c.length; i++) cur.tris.push([c[0], c[i], c[i + 1]]);
	}
}

// -------------------------------------------------- сборка буферов на объект

// Узлам даём сдвиг, а вершины на него компенсируем — геометрия в мире
// не меняется, но матрицы узлов перестают быть единичными и тоже проверяются.
const nodeOffset = i => [((i % 5) - 2) * 0.25, ((i % 3) - 1) * 0.5, ((i % 7) - 3) * 0.125];

const chunks = [];
let byteLength = 0;
const accessors = [], bufferViews = [], meshes = [], nodes = [];

function pushView(buf, target) {
	const pad = byteLength % 4 ? 4 - (byteLength % 4) : 0;
	if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
	const view = { buffer: 0, byteOffset: byteLength, byteLength: buf.length };
	if (target) view.target = target;
	bufferViews.push(view);
	chunks.push(buf);
	byteLength += buf.length;
	return bufferViews.length - 1;
}

objects.forEach((obj, oi) => {
	// уникальные вершины внутри объекта
	const map = new Map();
	const vp = [], vt = [], idx = [];
	const off = nodeOffset(oi);
	for (const tri of obj.tris) {
		for (const c of tri) {
			const key = `${c.v}/${c.t}`;
			if (!map.has(key)) {
				map.set(key, vp.length);
				const p = positions[c.v];
				vp.push([p[0] - off[0], p[1] - off[1], p[2] - off[2]]);
				// в OBJ ось V идёт вверх, в glTF — вниз
				vt.push(c.t < 0 ? [0, 0] : [uvs[c.t][0], 1 - uvs[c.t][1]]);
			}
			idx.push(map.get(key));
		}
	}

	const posBuf = Buffer.alloc(vp.length * 12);
	vp.forEach((p, i) => p.forEach((v, k) => posBuf.writeFloatLE(v, i * 12 + k * 4)));
	const uvBuf = Buffer.alloc(vt.length * 8);
	vt.forEach((t, i) => t.forEach((v, k) => uvBuf.writeFloatLE(v, i * 8 + k * 4)));
	const idxBuf = Buffer.alloc(idx.length * 4);
	idx.forEach((v, i) => idxBuf.writeUInt32LE(v, i * 4));

	const minP = [0, 1, 2].map(a => Math.min(...vp.map(p => p[a])));
	const maxP = [0, 1, 2].map(a => Math.max(...vp.map(p => p[a])));

	const posAcc = accessors.push({
		bufferView: pushView(posBuf, 34962), componentType: 5126,
		count: vp.length, type: 'VEC3', min: minP, max: maxP,
	}) - 1;
	const uvAcc = accessors.push({
		bufferView: pushView(uvBuf, 34962), componentType: 5126, count: vt.length, type: 'VEC2',
	}) - 1;
	const idxAcc = accessors.push({
		bufferView: pushView(idxBuf, 34963), componentType: 5125, count: idx.length, type: 'SCALAR',
	}) - 1;

	meshes.push({
		name: obj.name,
		primitives: [{ attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc }, indices: idxAcc, material: 0, mode: 4 }],
	});
	nodes.push({ name: obj.name, mesh: meshes.length - 1, translation: off });
});

const binary = Buffer.concat(chunks);

const baseGLTF = {
	asset: { version: '2.0', generator: 'make-gltf-fixtures' },
	scene: 0,
	scenes: [{ nodes: nodes.map((_, i) => i) }],
	nodes, meshes, accessors, bufferViews,
	materials: [{ name: 'material8', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
	textures: [{ source: 0 }],
	images: [{ uri: 'material8.png' }],
	buffers: [{ byteLength: binary.length }],
};

// ------------------------------------------------------- вариант 1: внешний .bin

const ext = structuredClone(baseGLTF);
ext.buffers[0].uri = 'model.bin';
fs.mkdirSync(path.join(outDir, 'external'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'external', 'model.gltf'), JSON.stringify(ext));
fs.writeFileSync(path.join(outDir, 'external', 'model.bin'), binary);

// ------------------------------------------------------- вариант 2: base64

const emb = structuredClone(baseGLTF);
emb.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.toString('base64');
fs.mkdirSync(path.join(outDir, 'embedded'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'embedded', 'model.gltf'), JSON.stringify(emb));

// ------------------------------------------------------- вариант 3: .glb

const glbJSON = structuredClone(baseGLTF);
const jsonBuf = Buffer.from(JSON.stringify(glbJSON));
const jsonPad = jsonBuf.length % 4 ? 4 - (jsonBuf.length % 4) : 0;
const binPad = binary.length % 4 ? 4 - (binary.length % 4) : 0;
const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + binary.length + binPad;

const glb = Buffer.alloc(total);
let p = 0;
glb.writeUInt32LE(0x46546C67, p); p += 4;
glb.writeUInt32LE(2, p); p += 4;
glb.writeUInt32LE(total, p); p += 4;
glb.writeUInt32LE(jsonBuf.length + jsonPad, p); p += 4;
glb.writeUInt32LE(0x4E4F534A, p); p += 4;
jsonBuf.copy(glb, p); p += jsonBuf.length;
for (let i = 0; i < jsonPad; i++) glb.writeUInt8(0x20, p++);   // JSON добивается пробелами
glb.writeUInt32LE(binary.length + binPad, p); p += 4;
glb.writeUInt32LE(0x004E4942, p); p += 4;
binary.copy(glb, p); p += binary.length;

fs.mkdirSync(path.join(outDir, 'glb'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'glb', 'model.glb'), glb);

console.log(`Собрано ${objects.length} объектов, буфер ${binary.length} байт`);
console.log(`  ${outDir}/external/model.gltf + model.bin`);
console.log(`  ${outDir}/embedded/model.gltf  (base64)`);
console.log(`  ${outDir}/glb/model.glb        (${glb.length} байт)`);

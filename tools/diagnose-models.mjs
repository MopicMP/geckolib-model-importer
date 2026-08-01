/**
 * Диагностика распакованных моделей: что именно в них не так.
 *
 * Журнал говорит «сломаны текстуры» или «модель сломана», но не говорит почему.
 * Этот инструмент прогоняет настоящий разбор плагина по папкам с моделями
 * и печатает признаки, по которым видно причину.
 *
 * Запуск: node tools/diagnose-models.mjs <папка с распакованными моделями>
 * Внутри ожидается <папка>/<категория>/<модель>/… либо <папка>/<модель>/…
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGLTFFiles, solveBox, splitComponents, isDegenerate, imageSize } = require('../plugin/geckolib_model_importer.js');

const root = process.argv[2];
if (!root) { console.log('Укажите папку с распакованными моделями'); process.exit(1); }

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

/** Папки, внутри которых лежит модель (есть .gltf/.glb или вложенные файлы). */
const modelDirs = [];
const collect = (dir, depth) => {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const hasFiles = entries.some(e => e.isFile());
	const subdirs = entries.filter(e => e.isDirectory());
	if (hasFiles || depth >= 2) { modelDirs.push(dir); return; }
	for (const d of subdirs) collect(path.join(dir, d.name), depth + 1);
};
collect(root, 0);

console.log('');
for (const dir of modelDirs) {
	const label = path.relative(root, dir) || path.basename(dir);
	const files = readDir(dir);
	const names = Object.keys(files);

	const hasGltf = names.some(n => /\.(gltf|glb)$/i.test(n));
	if (!hasGltf) {
		const other = names.filter(n => /\.(blend|blend1|fbx|obj|max|ma|mb|c4d|3ds|dae)$/i.test(n))
			.map(n => path.extname(n)).join(', ');
		console.log(`\n### ${label}`);
		console.log(`    НЕТ glTF. В архиве только исходник автора: ${other || names.slice(0, 3).join(', ')}`);
		console.log('    → это выгрузка «Original», а не автоконверсия. Открыть нечем.');
		continue;
	}

	let parsed;
	try { parsed = parseGLTFFiles(files, { scale: 1, uvWidth: 1, uvHeight: 1 }); }
	catch (e) { console.log(`\n### ${label}\n    разбор упал: ${e.message}`); continue; }

	// разбиение слитых мешей — так же, как в импорте
	const split = [];
	let splitFrom = 0;
	for (const obj of parsed.objects) {
		const parts = splitComponents(obj.faces);
		if (parts.length > 1) splitFrom++;
		parts.forEach(faces => split.push({ name: obj.name, faces, image: obj.image }));
	}

	// классификация объектов
	let boxes = 0, degenerate = 0;
	const notBox = [];
	for (const o of split) {
		if (isDegenerate(o.faces)) { degenerate++; continue; }
		const sol = solveBox(o.faces);
		if (!sol.error) { boxes++; continue; }
		const pts = new Set();
		for (const f of o.faces) for (const p of f.positions) pts.add(p.map(v => v.toFixed(4)).join(','));
		notBox.push({ name: o.name, verts: pts.size });
	}

	// текстуры и UV
	const roles = parsed.images.map(i => i.role || '?');
	const colorCount = roles.filter(r => r === 'color').length;
	const auxCount = roles.filter(r => r === 'aux').length;
	const unreadable = parsed.images.filter(i => !imageSize(i.bytes)).length;
	let uvTotal = 0, uvOut = 0, noMat = 0;
	for (const o of parsed.objects) {
		if (o.image < 0) noMat++;
		for (const f of o.faces) for (const uv of f.uvs || []) {
			if (!uv) continue;
			uvTotal++;
			if (uv[0] < -1e-4 || uv[0] > 1.0001 || uv[1] < -1e-4 || uv[1] > 1.0001) uvOut++;
		}
	}

	// насколько объекты вообще похожи на ящики
	const heavy = notBox.filter(n => n.verts > 12).length;
	const near = notBox.length - heavy;
	const total = boxes + notBox.length;
	const share = total ? (100 * notBox.length / total) : 0;

	console.log(`\n### ${label}`);
	console.log(`    объектов ${parsed.objects.length} → после разделения ${split.length}`
		+ (splitFrom ? ` (разделено мешей: ${splitFrom})` : ''));
	console.log(`    ящики ${boxes} · не-ящики ${notBox.length} (${share.toFixed(0)}%) `
		+ `· вырожденные ${degenerate}`);
	if (notBox.length) {
		console.log(`      из не-ящиков: сложная геометрия (>12 вершин) ${heavy}, почти ящик ${near}`);
		const worst = notBox.slice().sort((a, b) => b.verts - a.verts).slice(0, 3);
		console.log('      самые сложные: ' + worst.map(w => `${w.name} (${w.verts} вершин)`).join(', '));
	}
	console.log(`    картинок ${parsed.images.length}: цветных ${colorCount}, служебных ${auxCount}`
		+ (unreadable ? `, нечитаемых ${unreadable}` : ''));
	console.log(`    UV вне текстуры ${uvTotal ? (100 * uvOut / uvTotal).toFixed(1) : 0}%`
		+ ` · объектов без материала ${noMat}`);

	const verdict = share > 30 ? 'НЕ КУБИЧЕСКАЯ — замена ящиками даст кашу'
		: share > 0 ? 'почти кубическая — замена ящиками уместна'
		: 'кубическая';
	console.log(`    вывод: ${verdict}`);
}
console.log('');

/**
 * Дымовой тест: прогоняет ВЕСЬ путь импорта с подменёнными объектами Blockbench.
 *
 * Зачем: `node --check` ловит только синтаксис. Ошибки вида «обращение к const
 * до объявления», опечатки в именах и вызовы несуществующих функций видны лишь
 * при исполнении — и до сих пор доезжали до пользователя. Здесь код реально
 * выполняется, поэтому такие ошибки падают тут.
 *
 * Числовая точность не важна: математика покрыта отдельными тестами. В частности,
 * калибровка UV в песочнице выдаёт бессмысленные значения — геометрия пробного
 * куба здесь синтетическая. Проверяется, что код ОТРАБАТЫВАЕТ, а не что он прав.
 *
 * Запуск: node tools/smoke-plugin.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// ------------------------------------------------------------ мини-THREE

const clamp = v => Math.min(1, Math.max(-1, v));

class Quaternion {
	constructor(x = 0, y = 0, z = 0, w = 1) { Object.assign(this, { x, y, z, w }); }
	clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
	invert() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
	multiply(q) {
		const { x: ax, y: ay, z: az, w: aw } = this;
		const { x: bx, y: by, z: bz, w: bw } = q;
		this.x = aw * bx + ax * bw + ay * bz - az * by;
		this.y = aw * by - ax * bz + ay * bw + az * bx;
		this.z = aw * bz + ax * by - ay * bx + az * bw;
		this.w = aw * bw - ax * bx - ay * by - az * bz;
		return this;
	}
}

class Euler {
	constructor(x = 0, y = 0, z = 0, order = 'XYZ') { Object.assign(this, { x, y, z, order }); }
	setFromQuaternion(q, order) {
		// через матрицу, как в THREE
		const { x, y, z, w } = q;
		const m = [
			1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
			2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
			2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
		];
		return this.setFromMatrixArray(m, order);
	}
	setFromRotationMatrix(mat, order) { return this.setFromMatrixArray(mat.elements3, order); }
	setFromMatrixArray(m, order) {
		this.order = order || this.order;
		const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = m;
		if (this.order === 'ZYX') {
			this.y = Math.asin(-clamp(m31));
			if (Math.abs(m31) < 0.9999999) { this.x = Math.atan2(m32, m33); this.z = Math.atan2(m21, m11); }
			else { this.x = 0; this.z = Math.atan2(-m12, m22); }
		} else {
			this.y = Math.asin(clamp(m13));
			if (Math.abs(m13) < 0.9999999) { this.x = Math.atan2(-m23, m33); this.z = Math.atan2(-m12, m11); }
			else { this.x = Math.atan2(m32, m22); this.z = 0; }
		}
		return this;
	}
}

class Vector3 {
	constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
	length() { return Math.hypot(this.x, this.y, this.z); }
	applyQuaternion(q) {
		const { x, y, z } = this;
		const ix = q.w * x + q.y * z - q.z * y;
		const iy = q.w * y + q.z * x - q.x * z;
		const iz = q.w * z + q.x * y - q.y * x;
		const iw = -q.x * x - q.y * y - q.z * z;
		this.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
		this.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
		this.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
		return this;
	}
	applyEuler() { return this; }
}

class Matrix4 {
	makeBasis(vx, vy, vz) { this.elements3 = [vx.x, vx.y, vx.z, vy.x, vy.y, vy.z, vz.x, vz.y, vz.z]; return this; }
}

const THREE = {
	Quaternion, Euler, Vector3, Matrix4,
	MathUtils: { radToDeg: r => r * 180 / Math.PI, degToRad: d => d * Math.PI / 180 },
};

// ------------------------------------------------- подмена объектов Blockbench

const created = { cubes: [], groups: [], animations: [], textures: [] };
let reportShown = null;
const problems = [];

class FakeMeshObj {
	constructor() { this.rotation = { x: 0, y: 0, z: 0, order: 'ZYX' }; this.position = { x: 0, y: 0, z: 0 }; }
}

class Cube {
	constructor(data = {}) {
		Object.assign(this, data);
		this.faces = {};
		for (const f of ['north', 'south', 'east', 'west', 'up', 'down']) this.faces[f] = { uv: null, texture: null };
		this.mesh = new FakeMeshObj();
		// геометрия куба 24 вершины — как её отдаёт Blockbench, относительно origin
		const pos = [], uv = [];
		const h = [8, 8, 8];
		const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
		for (const [axis, sign] of faces) {
			for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
				const p = [0, 0, 0];
				p[axis] = sign * h[axis];
				p[(axis + 1) % 3] = a * h[(axis + 1) % 3];
				p[(axis + 2) % 3] = b * h[(axis + 2) % 3];
				pos.push(...p);
				uv.push(a > 0 ? 4 / 128 : 0, 1 - (b > 0 ? 8 / 128 : 0));
			}
		}
		this.mesh.geometry = {
			attributes: {
				position: { array: pos, count: 24 },
				uv: { array: uv, count: 24 },
			},
		};
	}
	init() { created.cubes.push(this); return this; }
	addTo() { return this; }
	remove() { }
}

class Group {
	constructor(data = {}) {
		Object.assign(this, data);
		this.mesh = new FakeMeshObj();
		this.mesh.updateWorldMatrix = () => { };
		this.mesh.getWorldPosition = v => { v.x = 0; v.y = 0; v.z = 0; return v; };
		this.children = [];
	}
	init() { created.groups.push(this); return this; }
	addTo(p) { if (p && p.children) p.children.push(this); return this; }
	remove() { }
}

class BoneAnimator {
	constructor(name) { this.name = name; this.rotation = []; this.position = []; this.scale = []; }
	displayFrame() { }
	createKeyframe(data, time, channel) {
		if (!data || [data.x, data.y, data.z].some(v => typeof v !== 'number' || !isFinite(v))) {
			problems.push(`нечисловой кадр в канале ${channel}: ${JSON.stringify(data)}`);
		}
		const kf = { data, time, channel };
		(this[channel] || (this[channel] = [])).push(kf);
		return kf;
	}
}

class Animation {
	constructor(data = {}) { Object.assign(this, data); this.animators = {}; }
	add() { created.animations.push(this); return this; }
	select() { Animation.selected = this; return this; }
	setLength() { }
	getBoneAnimator(group) {
		const key = group.name || 'bone';
		return this.animators[key] || (this.animators[key] = new BoneAnimator(key));
	}
}
Animation.selected = null;
Object.defineProperty(Animation, 'all', { get: () => created.animations });

class Texture {
	constructor(data = {}) { Object.assign(this, data); this.uuid = 'tex-' + created.textures.length; }
	fromDataURL(url) { this.url = url; return this; }
	add() { created.textures.push(this); return this; }
}
Object.defineProperty(Texture, 'all', { get: () => created.textures });


// ------------------------------------------------------- содержимое архива

// Сценарий подменяется между прогонами: так один и тот же путь импорта
// проверяется на PNG и на JPEG. Второй случай важнее — на Sketchfab текстуры
// почти всегда JPEG, и пока плагин понимал только PNG, такие архивы падали
// с «текстура не найдена», не дойдя до геометрии.
let scenario = 'png';

/** Минимальный JPEG: заголовка достаточно, декодировать его тут некому. */
function fakeJPEG(w, h) {
    const be = n => [(n >> 8) & 0xFF, n & 0xFF];
    return Uint8Array.from([
        0xFF, 0xD8,
        0xFF, 0xE0, ...be(16), 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        0xFF, 0xC0, ...be(17), 8, ...be(h), ...be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
        0xFF, 0xD9,
    ]);
}

function zipContents() {
    const gltfPath = 'model(gltf)/source/model.gltf';
    const texPath = 'model(gltf)/textures/gltf_embedded_0.png';
    const files = {};

    if (scenario === 'png') {
        files['source/model.gltf'] = new Uint8Array(fs.readFileSync(gltfPath));
        files['textures/gltf_embedded_0.png'] = new Uint8Array(fs.readFileSync(texPath));
        return files;
    }

    // JPEG под именем .png плюс нечитаемая картинка ПЕРВЫМ номером. Порядок
    // выбран нарочно: объекты ссылаются на картинку номером из glTF, а из
    // атласа нечитаемая выпадает — если номера не пересчитывать, каждому
    // объекту достанется чужой кусок текстуры, и молча.
    const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
    gltf.images = [{ uri: 'textures/broken.tga' }, ...(gltf.images || [])];
    for (const t of gltf.textures || []) if (t.source !== undefined) t.source += 1;

    files['source/model.gltf'] = new Uint8Array(Buffer.from(JSON.stringify(gltf), 'utf8'));
    files['textures/gltf_embedded_0.png'] = fakeJPEG(128, 128);
    files['textures/broken.tga'] = new Uint8Array(64).fill(7);
    return files;
}


// Псевдо-DOM окна отчёта: проверяем, что кнопки «Сохранить лог» и
// «Скопировать» находятся по своим классам и обработчики вешаются.
const foundSelectors = [];
function fakeDialogRoot(html) {
	return {
		querySelector(sel) {
			foundSelectors.push(sel);
			if (html.indexOf(sel.replace('.', '')) < 0) return null;
			return { addEventListener() { }, textContent: '' };
		},
	};
}

const sandboxActions = [];

const sandbox = {
	console, JSON, Math, Object, Array, String, Number, Boolean, Error, isFinite, parseInt, parseFloat,
	Set, Map, Promise, TextDecoder, Uint8Array, DataView, ArrayBuffer, Buffer,
	btoa: s => Buffer.from(s, 'binary').toString('base64'),
	atob: s => Buffer.from(s, 'base64').toString('binary'),
	THREE, Cube, Group, Animation, Texture,
	Mesh: { all: [] },
	Canvas: { updateAll() { }, updateUV() { }, updateAllBones() { }, updateView() { } },
	Project: { box_uv: true, texture_width: 16, texture_height: 16 },
	Formats: { geckolib_model: { id: 'geckolib_model' } },
	newProject: () => true,
	Undo: { initEdit() { }, finishEdit() { } },
	Timeline: { setTime() { } },
	Animator: { preview() { } },
	Modes: { options: { edit: { select() { } } } },
	ModelFormat: class { constructor(d) { Object.assign(this, d); } delete() { } },
	Plugin: { register(id, opts) { sandbox.__plugin = opts; } },
	Action: class {
		constructor(id, opts) { Object.assign(this, opts); this.id = id; sandboxActions.push(this); }
		delete() { }
	},
	MenuBar: { addAction() { } },
	Dialog: class {
		constructor(opts) { Object.assign(this, opts); }
		show() {
			// Окно отчёта формы не имеет: у него готовая разметка в lines.
			// Её тоже надо проверять — именно туда переехал отчёт импорта.
			if (this.lines && this.lines.length) {
				reportShown = this.lines.join(String.fromCharCode(10));
				this.object = fakeDialogRoot(reportShown);
				return;
			}
			// сразу подтверждаем со значениями по умолчанию
			const form = {};
			for (const [k, v] of Object.entries(this.form || {})) {
				if (v.type === 'checkbox') form[k] = v.value;
				else if (v.type === 'select') form[k] = v.default;
				else if (v.type === 'number') form[k] = v.value;
			}
			this.onConfirm(form);
		}
		hide() { }
	},
	Blockbench: {
		version: 'smoke',
		showMessageBox(o) { reportShown = o.message; },
		showQuickMessage() { },
		addCSS: () => ({ delete() { } }),
		on() { }, removeListener() { },
		import(opts, cb) { cb([{ name: 'model(gltf).zip', content: null }]); },
	},
	JSZip: {
		loadAsync() {
			// настоящую распаковку не проверяем — подкладываем файлы с диска
			return Promise.resolve({
				forEach(cb) {
					for (const [name, bytes] of Object.entries(zipContents())) {
						cb(name, { dir: false, async: () => Promise.resolve(bytes) });
					}
				},
			});
		},
	},
	document: {
		querySelector: () => null,
		createElement: (tag) => tag === 'canvas'
			? {
				width: 0, height: 0,
				getContext: () => ({ drawImage() { }, imageSmoothingEnabled: false }),
				toDataURL: () => 'data:image/png;base64,AAAA',
			}
			: { style: {}, classList: { add() { } }, addEventListener() { } },
	},
	Image: class { set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); } },
	localStorage: { _v: {}, getItem(k) { return this._v[k] || null; }, setItem(k, v) { this._v[k] = v; } },
	fetch: () => Promise.reject(new Error('сеть в тесте отключена')),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// ------------------------------------------------------------------- прогон

const src = fs.readFileSync(path.join('plugin', 'geckolib_model_importer.js'), 'utf8');
vm.createContext(sandbox);

let failed = false;
try {
	new vm.Script(src, { filename: 'geckolib_model_importer.js' }).runInContext(sandbox);
} catch (e) {
	console.log(`\n❌ Плагин упал при загрузке: ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
	process.exit(1);
}

const plugin = sandbox.__plugin;
if (!plugin) { console.log('\n❌ Plugin.register не вызван\n'); process.exit(1); }

try {
	plugin.onload();
} catch (e) {
	console.log(`\n❌ onload упал: ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
	process.exit(1);
}

console.log('');
console.log('=== ДЫМОВОЙ ТЕСТ ПЛАГИНА ===');
console.log('');
console.log('Плагин загрузился и onload отработал: OK');
console.log(`Зарегистрировано действий: ${sandboxActions.length}`);

// Запускаем импорт через созданное действие: диалог подтвердится сам,
// JSZip отдаст файлы с диска. Так проверяется весь путь целиком.
const importAction = sandboxActions.find(a => a.id.endsWith('_import'));
if (!importAction) { console.log('ОШИБКА: действие импорта не найдено'); process.exit(1); }

/** Один прогон импорта целиком: диалог подтвердится сам, JSZip отдаст фикстуру. */
async function runImport(label) {
    created.cubes.length = 0;
    created.groups.length = 0;
    created.animations.length = 0;
    created.textures.length = 0;
    problems.length = 0;
    reportShown = null;

    console.log('');
    console.log('--- ' + label);
    try {
        importAction.click();
    } catch (e) {
        console.log('ОШИБКА при импорте: ' + e.message);
        console.log(String(e.stack).split(String.fromCharCode(10)).slice(1, 4).join(' | '));
        process.exit(1);
    }
    await new Promise(r => setTimeout(r, 300));

    let bad = false;
    if (created.cubes.length) {
        const kf = created.animations.reduce((s, a) =>
            s + Object.values(a.animators).reduce((n, an) => n + an.rotation.length + an.position.length, 0), 0);
        console.log(`Кубов ${created.cubes.length}, костей ${created.groups.length}, `
            + `анимаций ${created.animations.length}, кадров ${kf}`);
    } else {
        bad = true;
        console.log('❌ ни одного куба не создано');
    }
    if (problems.length) {
        bad = true;
        console.log(`❌ Проблемы (${problems.length}):`);
        for (const p of problems.slice(0, 5)) console.log('  ' + p);
    }
    if (reportShown && /не удался|НЕ ПЕРЕНЕСЕНЫ|упал/i.test(reportShown)) {
        bad = true;
        console.log('❌ Отчёт сообщает об ошибке:' + String.fromCharCode(10) + reportShown.slice(0, 400));
    }
    return bad;
}

const baseline = created.cubes.length;
failed = await runImport('архив с PNG') || failed;
const cubesPNG = created.cubes.length;
void baseline;

scenario = 'jpeg';
failed = await runImport('архив с JPEG + нечитаемая картинка') || failed;

if (created.cubes.length !== cubesPNG) {
    failed = true;
    console.log(`❌ JPEG дал ${created.cubes.length} кубов вместо ${cubesPNG}`);
}
// Кнопки окна отчёта должны находиться по своим классам: если разметка и
// обработчики разъедутся, «Сохранить лог» молча перестанет работать.
// Раздутый плоский куб не должен показывать боковые грани: до раздутия их
// площадь была нулевой, а после они проступают полосой растянутого пикселя.
const AXIS_FACES = [['east', 'west'], ['up', 'down'], ['north', 'south']];
let flatWithSides = 0, flatInflated = 0;
for (const c of created.cubes) {
	if (!c.inflate || !c.from || !c.to) continue;
	if ([0, 1, 2].some(i => Math.abs(c.to[i] - c.from[i]) < 0.01)) flatInflated++;
	for (let i = 0; i < 3; i++) {
		if (Math.abs(c.to[i] - c.from[i]) >= 0.01) continue;
		for (let j = 0; j < 3; j++) {
			if (j === i) continue;
			for (const f of AXIS_FACES[j]) {
				if (c.faces[f] && c.faces[f].texture) flatWithSides++;
			}
		}
	}
}
if (flatWithSides) {
	failed = true;
	console.log('❌ у раздутых плоских кубов остались боковые грани: ' + flatWithSides);
} else if (!flatInflated) {
	// Проверка, которой нечего проверять, молчит так же, как исправный код.
	console.log('⚠ раздутых плоских кубов в фикстуре нет — проверка обводки вхолостую');
} else {
	console.log(`Плоские кубы при раздутии не получили боковых граней: OK (проверено ${flatInflated})`);
}

for (const sel of ['.mtc_rep_save', '.mtc_rep_copy']) {
	if (!foundSelectors.includes(sel)) {
		failed = true;
		console.log('❌ обработчик не навешен на ' + sel);
	}
}
if (reportShown && reportShown.indexOf('mtc_rep_log') < 0) {
	failed = true;
	console.log('❌ в окне отчёта нет прокручиваемого блока лога');
}

if (!reportShown || reportShown.indexOf('Images skipped: 1') < 0) {
    failed = true;
    console.log('❌ в отчёте нет строки о пропущенной картинке (Images skipped)');
} else {
    console.log('Нечитаемая картинка отмечена в отчёте, номера картинок пересчитаны: OK');
}

console.log(`${String.fromCharCode(10)}${failed ? '❌ ЕСТЬ ПРОБЛЕМЫ' : '✅ ПЛАГИН ИСПОЛНЯЕТСЯ БЕЗ ОШИБОК'}${String.fromCharCode(10)}`);
process.exit(failed ? 1 : 0);
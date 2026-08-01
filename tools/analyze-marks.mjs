/**
 * Разбор журнала отмеченных моделей: чем проблемные отличаются от рабочих.
 *
 * Заметки печатаются ЦЕЛИКОМ и ВСЕ — именно в отрезанных хвостах пряталось
 * то, что конкретно сломано. Длинный вывод лучше потерянного факта.
 *
 * Запуск: node tools/analyze-marks.mjs logs2.md [logs.md]
 *   Второй файл, если указан, служит «прошлым» состоянием: показывается,
 *   какие модели изменили отметку.
 */
import fs from 'node:fs';

/**
 * Журнал выгружается как JSON, но имена моделей с Sketchfab содержат и
 * обратные слэши, и кавычки («foxy"s fun house»), а выгрузка их не экранирует.
 * Чиним построчно: внутри строковых значений заменяем внутренние кавычки.
 */
function loadMarks(file) {
	let text = fs.readFileSync(file, 'utf8');
	// одиночный обратный слэш — недопустимая escape-последовательность
	text = text.replace(/\\(?!["\\/bfnrtu])/g, '');
	try { return JSON.parse(text); } catch { /* чиним кавычки ниже */ }

	// Кавычка внутри значения: та, после которой не идёт разделитель JSON.
	const fixed = text.replace(/"((?:[^"\\]|\\.)*)"/g, (m) => m);
	const lines = text.split('\n').map(line => {
		const kv = /^(\s*"[^"]*"\s*:\s*")(.*)("\s*,?\s*)$/.exec(line);
		if (!kv) return line;
		return kv[1] + kv[2].replace(/"/g, "'") + kv[3];
	});
	void fixed;
	return JSON.parse(lines.join('\n'));
}

const file = process.argv[2] || 'logs.md';
const prevFile = process.argv[3];
const marks = loadMarks(file);
const all = Object.values(marks);

const by = s => all.filter(m => (m.status || '') === s);
const groups = { ok: by('ok'), issues: by('issues'), fail: by('fail') };
const unmarked = all.length - groups.ok.length - groups.issues.length - groups.fail.length;

console.log(`\nВсего ${all.length}: ok ${groups.ok.length}, issues ${groups.issues.length}, `
	+ `fail ${groups.fail.length}, без отметки ${unmarked}\n`);

// ---------------------------------------------- что изменилось с прошлого раза

if (prevFile && fs.existsSync(prevFile)) {
	const prev = loadMarks(prevFile);
	const moved = { 'стало лучше': [], 'стало хуже': [] };
	const rank = { fail: 0, issues: 1, ok: 2 };
	for (const [key, m] of Object.entries(marks)) {
		const was = prev[key];
		if (!was || !was.status || was.status === m.status) continue;
		const dir = rank[m.status] > rank[was.status] ? 'стало лучше' : 'стало хуже';
		moved[dir].push(`${m.name}: ${was.status} → ${m.status}`);
	}
	console.log('=== Сдвиги отметок относительно прошлого журнала ===');
	for (const [dir, list] of Object.entries(moved)) {
		console.log(`  ${dir}: ${list.length}`);
		for (const l of list) console.log(`     ${l}`);
	}
	console.log('');
}

// ---------------------------------------------- средние по группам

console.log('=== Средние по группам ===');
const avg = (list, pick) => {
	const v = list.map(pick).filter(x => typeof x === 'number' && isFinite(x));
	return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fields = [
	['объектов', m => m.stats && m.stats.objects],
	['не-кубов', m => m.stats && m.stats.notBoxes],
	['доля не-кубов %', m => m.stats && m.stats.objects ? 100 * (m.stats.notBoxes || 0) / m.stats.objects : null],
	['текстур', m => m.stats && m.stats.images],
	['множитель', m => m.stats && m.stats.scale],
	['габарит, ед.', m => m.stats && m.stats.sizeUnits],
	['UV вне текстуры %', m => m.stats && m.stats.uvOutside],
	['без материала', m => m.stats && m.stats.noMaterial],
	['разделено мешей', m => m.stats && m.stats.splitFrom],
];
console.log('  ' + 'признак'.padEnd(20) + ['ok', 'issues', 'fail'].map(x => x.padStart(10)).join(''));
for (const [name, pick] of fields) {
	console.log('  ' + name.padEnd(20) + ['ok', 'issues', 'fail']
		.map(g => { const v = avg(groups[g], pick); return (v === null ? '—' : v.toFixed(1)).padStart(10); }).join(''));
}

// ---------------------------------------------- разделяющий признак

console.log('\n=== Доля не-кубов: разделяет ли она группы ===');
for (const [name, g] of Object.entries(groups)) {
	const withStats = g.filter(m => m.stats && m.stats.objects);
	const zero = withStats.filter(m => !m.stats.notBoxes).length;
	const some = withStats.filter(m => m.stats.notBoxes && m.stats.notBoxes < m.stats.objects / 2).length;
	const most = withStats.filter(m => m.stats.notBoxes >= m.stats.objects / 2).length;
	console.log(`  ${name.padEnd(7)} со статистикой ${String(withStats.length).padStart(3)}: `
		+ `ни одного не-куба ${String(zero).padStart(3)} · меньше половины ${String(some).padStart(3)} `
		+ `· больше половины ${String(most).padStart(3)}`);
}

// ---------------------------------------------- все заметки целиком

for (const [name, g] of Object.entries(groups)) {
	const withNote = g.filter(m => m.note);
	if (!withNote.length) continue;
	console.log(`\n=== Заметки: ${name} (${withNote.length}) ===`);
	for (const m of withNote) {
		const s = m.stats;
		console.log(`\n  ${m.name}`);
		console.log(`    ${m.note}`);
		if (s) {
			const bits = [
				s.objects !== undefined ? `объектов ${s.objects}` : null,
				s.notBoxes !== undefined ? `не-кубов ${s.notBoxes}` : 'поля не-кубов НЕТ',
				s.degenerate ? `вырожденных ${s.degenerate}` : null,
				s.badMode ? `режим ${s.badMode}` : null,
				s.images !== undefined ? `текстур ${s.images}` : null,
				s.formats ? `формат ${s.formats}` : null,
				s.scale !== undefined ? `множитель ${s.scale}` : null,
				s.autoScale !== undefined && s.autoScale !== s.scale ? `авто предлагал ${s.autoScale}` : null,
				s.sizeUnits !== undefined ? `габарит ${s.sizeUnits}` : null,
				s.uvOutside ? `UV вне текстуры ${s.uvOutside}%` : null,
				s.noMaterial ? `без материала ${s.noMaterial}` : null,
				s.atlas ? `атлас ${s.atlas}` : null,
				s.animations ? `анимаций ${s.animations}` : null,
				s.result ? `итог: ${s.result}` : null,
			].filter(Boolean);
			console.log(`    [${bits.join(' · ')}]`);
			for (const ex of s.notBoxExamples || []) console.log(`      ${ex}`);
		} else {
			console.log('    [статистики нет — импорт не дошёл до разбора]');
		}
	}
}

console.log('');

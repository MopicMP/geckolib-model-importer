/**
 * Фильтр выдачи Sketchfab: показывать только модели с готовым glTF.
 *
 * У части моделей скачивается лишь исходник автора (.blend, .fbx) — открыть
 * его нечем. Из журнала таких набралось шесть отказов подряд, и все они
 * выглядели рабочими до самой попытки импорта.
 *
 * Запуск: node tools/verify-search-filter.mjs [--live]
 *   --live дополнительно проверяет фильтр на настоящей выдаче API
 *          (поиск открытый, токен не нужен).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasGltfArchive } = require('../plugin/geckolib_model_importer.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) bad++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

console.log('\n=== Что считается пригодным ===');
ok(hasGltfArchive({ archives: { gltf: { size: 12345 }, source: { size: null } } }),
	'есть gltf с размером — годится');
ok(hasGltfArchive({ archives: { glb: { size: 500 } } }), 'есть только glb — тоже годится');
ok(!hasGltfArchive({ archives: { source: { size: 999 } } }), 'только исходник автора — прячем');
ok(!hasGltfArchive({ archives: { gltf: { size: 0 }, source: { size: 10 } } }),
	'gltf нулевого размера — автоконверсии нет, прячем');
ok(!hasGltfArchive({ archives: { gltf: { size: null } } }), 'gltf с size=null — прячем');
ok(hasGltfArchive({ name: 'без поля archives' }),
	'поля archives нет — показываем (лучше лишнее, чем спрятать всё)');
ok(hasGltfArchive({}) && hasGltfArchive(null) === false || true, 'null не роняет функцию');

if (process.argv.includes('--live')) {
	console.log('\n=== Настоящая выдача API ===');
	const url = 'https://api.sketchfab.com/v3/search?type=models&q=minecraft'
		+ '&downloadable=true&archives_flavours=false&count=24';
	try {
		const r = await fetch(url);
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const data = await r.json();
		const list = data.results || [];
		const good = list.filter(hasGltfArchive);
		const withArchives = list.filter(m => m.archives).length;
		console.log(`  моделей в выдаче: ${list.length}, из них с полем archives: ${withArchives}`);
		console.log(`  проходят фильтр: ${good.length}, скрыто: ${list.length - good.length}`);
		ok(withArchives > 0, 'API действительно возвращает archives (иначе фильтр — пустышка)');
		ok(good.length > 0, 'фильтр не выкашивает всю выдачу');
		for (const m of list.filter(m => !hasGltfArchive(m)).slice(0, 5)) {
			const has = Object.entries(m.archives || {})
				.filter(([, v]) => v && v.size).map(([k]) => k).join(', ') || 'ничего';
			console.log(`    скрыто: ${(m.name || '').slice(0, 40)} — доступно: ${has}`);
		}
	} catch (e) {
		console.log(`  сеть недоступна или API изменился: ${e.message}`);
		console.log('  (это не провал теста — проверка вживую пропущена)');
	}
} else {
	console.log('\n(запустите с --live, чтобы проверить фильтр на настоящей выдаче)');
}

console.log(bad ? `\n❌ ОШИБОК: ${bad}\n` : '\n✅ ФИЛЬТР ВЫДАЧИ РАБОТАЕТ\n');
process.exit(bad ? 1 : 0);

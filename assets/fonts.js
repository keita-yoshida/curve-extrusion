import { parse as parseFont } from '../vendor/opentype/opentype.min.js';

/**
 * フォントの読み込みと、文字列 → 輪郭 の変換。
 *
 * 同梱フォント（日本語込み・1.8MB）は文字ツールを最初に使ったときだけ取りに行く。
 * ユーザーが読み込んだフォントは IndexedDB に入れて、次回以降そのまま使えるようにする。
 */

export const DEFAULT_FONT_KEY = 'kosugi-maru';

const DEFAULT_FONT = {
	key: DEFAULT_FONT_KEY,
	name: 'Kosugi Maru（同梱）',
	url: '../vendor/fonts/kosugi-maru-400.woff'
};

const DB_NAME = 'curve-extrusion';
const STORE = 'fonts';

/** key → { key, name, font } */
const loaded = new Map();

let defaultPromise = null;

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);

		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) {
				request.result.createObjectStore(STORE, { keyPath: 'key' });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function withStore(mode, run) {
	return openDb().then(
		(db) =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, mode);
				const request = run(tx.objectStore(STORE));

				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			})
	);
}

function register(key, name, buffer) {
	const font = parseFont(buffer);
	const entry = { key, name, font };

	loaded.set(key, entry);

	return entry;
}

/** 同梱フォントを（必要になったときに）読み込む */
export function ensureDefaultFont() {
	if (loaded.has(DEFAULT_FONT_KEY)) return Promise.resolve(loaded.get(DEFAULT_FONT_KEY));

	defaultPromise ??= fetch(new URL(DEFAULT_FONT.url, import.meta.url))
		.then((response) => {
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return response.arrayBuffer();
		})
		.then((buffer) => register(DEFAULT_FONT_KEY, DEFAULT_FONT.name, buffer))
		.catch((error) => {
			defaultPromise = null;
			throw new Error(`同梱フォントを読み込めませんでした: ${error.message}`);
		});

	return defaultPromise;
}

/** 前回ユーザーが読み込んだフォントを復元する */
export async function restoreStoredFonts() {
	try {
		const rows = await withStore('readonly', (store) => store.getAll());

		for (const row of rows ?? []) {
			try {
				register(row.key, row.name, row.buffer);
			} catch {
				// 壊れているフォントは黙って飛ばす
			}
		}
	} catch {
		// IndexedDB が使えない環境でも、同梱フォントだけで動作させる
	}
}

/** ユーザーが選んだフォントファイルを取り込む */
export async function addFontFromFile(file) {
	const buffer = await file.arrayBuffer();
	const key = `user:${file.name}`;

	// 対応していない形式ならここで例外になる
	const entry = register(key, file.name.replace(/\.[^.]+$/, ''), buffer);

	try {
		await withStore('readwrite', (store) => store.put({ key, name: entry.name, buffer }));
	} catch {
		// 保存できなくても今回のセッションでは使える
	}

	return entry;
}

export function getFont(key) {
	return loaded.get(key) ?? null;
}

/** 同梱フォントを先頭に、以降はユーザーが読み込んだ順で返す */
export function fontEntries() {
	const entries = [...loaded.values()];

	return entries.sort((a, b) => (a.key === DEFAULT_FONT_KEY ? -1 : b.key === DEFAULT_FONT_KEY ? 1 : 0));
}

/** 2次ベジェを3次に変換する（opentype は Q を返すが、輪郭は C で持つ） */
function quadraticToCubic(from, control, to) {
	return [
		[from[0] + (2 / 3) * (control[0] - from[0]), from[1] + (2 / 3) * (control[1] - from[1])],
		[to[0] + (2 / 3) * (control[0] - to[0]), to[1] + (2 / 3) * (control[1] - to[1])]
	];
}

/** opentype の Path を、エディター内部の輪郭表現へ変換する */
function pathToContours(path) {
	const contours = [];
	let current = null;
	let point = [0, 0];

	for (const command of path.commands) {
		switch (command.type) {
			case 'M':
				if (current && current.segs.length > 0) contours.push(current);
				point = [command.x, command.y];
				current = { start: point, segs: [] };
				break;

			case 'L':
				point = [command.x, command.y];
				current?.segs.push({ to: point });
				break;

			case 'C': {
				const to = [command.x, command.y];
				current?.segs.push({ c1: [command.x1, command.y1], c2: [command.x2, command.y2], to });
				point = to;
				break;
			}

			case 'Q': {
				const to = [command.x, command.y];
				const [c1, c2] = quadraticToCubic(point, [command.x1, command.y1], to);
				current?.segs.push({ c1, c2, to });
				point = to;
				break;
			}

			case 'Z':
				if (current && current.segs.length > 0) contours.push(current);
				current = null;
				break;
		}
	}

	if (current && current.segs.length > 0) contours.push(current);

	return contours;
}

/**
 * 文字列を輪郭へ変換する。
 *
 * 座標は em 単位（フォントサイズ1）で返し、1行目のベースラインを y=0 に置く。
 * こうしておくと、あとから拡大縮小するのにフォントを読み直す必要がない。
 */
export function buildTextContours(font, { text, tracking = 0, lineHeight = 1.3, align = 'left' }) {
	const options = { kerning: true, letterSpacing: tracking };
	const lines = String(text ?? '').split('\n');
	const contours = [];
	const missing = new Set();

	lines.forEach((line, index) => {
		for (const char of line) {
			if (char !== ' ' && font.charToGlyphIndex(char) === 0) missing.add(char);
		}

		if (line.length === 0) return;

		// getAdvanceWidth は最後の文字のうしろにも字間を足すので、その分を引く
		const width = Math.max(0, font.getAdvanceWidth(line, 1, options) - tracking);
		const offsetX = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;

		contours.push(...pathToContours(font.getPath(line, offsetX, index * lineHeight, 1, options)));
	});

	return { contours, missing: [...missing] };
}

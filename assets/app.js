import * as THREE from 'three';
import { STLExporter } from '../vendor/three/STLExporter.js';
import { extrudeRegions, regionsBoundingBox, transformRegions } from './regions.js';
import { svgToRegions } from './svg-source.js';
import { dxfToRegions } from './dxf-source.js';
import { Viewer } from './viewer.js';

const el = (id) => document.getElementById(id);

const ui = {
	drop: el('drop'),
	file: el('file'),
	filename: el('filename'),
	thickness: el('thickness'),
	scaleMode: el('scale-mode'),
	scaleValue: el('scale-value'),
	scaleNote: el('scale-note'),
	segments: el('segments'),
	segmentsOut: el('segments-out'),
	holeModeField: el('hole-mode-field'),
	holeMode: el('hole-mode'),
	center: el('center'),
	edges: el('edges'),
	download: el('download'),
	placeholder: el('placeholder'),
	stats: el('stats'),
	statSize: el('stat-size'),
	statRegions: el('stat-regions'),
	statVertices: el('stat-vertices'),
	statFaces: el('stat-faces'),
	messages: el('messages')
};

const viewer = new Viewer(el('canvas'));
const exporter = new STLExporter();

/** 読み込み済みファイルの内容と、そこから作った素の（未スケーリングの）リージョン */
let source = null;
let geometry = null;

function showMessages(items) {
	ui.messages.replaceChildren();

	for (const { text, tone } of items) {
		const p = document.createElement('p');
		p.className = `message ${tone}`;
		p.textContent = text;
		ui.messages.append(p);
	}
}

function formatNumber(value) {
	if (!Number.isFinite(value)) return '—';
	if (Math.abs(value) >= 100) return value.toFixed(1);
	if (Math.abs(value) >= 1) return value.toFixed(2);

	return value.toPrecision(3);
}

/** 現在の設定でファイルを解析し直す（分割数・穴の判定を変えたとき） */
function parseSource() {
	const curveSegments = Number(ui.segments.value);

	if (source.kind === 'svg') {
		// SVG は Y軸が下向きなので押し出し前に反転させる
		return { ...svgToRegions(source.text, { curveSegments, holeMode: ui.holeMode.value }), flipY: true };
	}

	return { ...dxfToRegions(source.text, { curveSegments }), flipY: false };
}

/** スケールモードに応じて「1単位あたり何mmか」を決める */
function resolveScale(parsed) {
	const mode = ui.scaleMode.value;
	const value = Number(ui.scaleValue.value);

	if (mode === 'auto') return parsed.scale?.mmPerUnit ?? 1;
	if (mode === 'manual') return value > 0 ? value : 1;

	const size = regionsBoundingBox(parsed.regions).getSize(new THREE.Vector2());
	const extent = mode === 'width' ? size.x : size.y;

	return extent > 0 && value > 0 ? value / extent : 1;
}

function rebuild() {
	if (!source) return;

	const messages = [];
	let parsed;

	try {
		parsed = source.parsed ?? parseSource();
		source.parsed = parsed;
	} catch (error) {
		console.error(error);
		showMessages([{ text: `解析に失敗しました: ${error.message}`, tone: 'error' }]);
		reset();
		return;
	}

	for (const warning of parsed.warnings ?? []) messages.push({ text: warning, tone: 'warn' });

	if (parsed.regions.length === 0) {
		messages.push({
			text: '閉じた領域が見つかりませんでした。パスが閉じている（塗りつぶせる形状になっている）か確認してください。',
			tone: 'error'
		});
		showMessages(messages);
		reset();
		return;
	}

	const scale = resolveScale(parsed);
	const scaled = transformRegions(parsed.regions, { scale, flipY: parsed.flipY });
	const thickness = Math.max(0.001, Number(ui.thickness.value) || 1);

	geometry = extrudeRegions(scaled, { thickness, centerOrigin: ui.center.checked });

	if (!geometry) {
		messages.push({ text: 'メッシュを生成できませんでした。', tone: 'error' });
		showMessages(messages);
		reset();
		return;
	}

	viewer.setGeometry(geometry);
	viewer.setEdgesVisible(ui.edges.checked);

	const size = geometry.boundingBox.getSize(new THREE.Vector3());
	const holes = parsed.regions.reduce((sum, region) => sum + region.holes.length, 0);

	ui.statSize.textContent = `${formatNumber(size.x)} × ${formatNumber(size.y)} × ${formatNumber(size.z)} mm`;
	ui.statRegions.textContent = `${parsed.regions.length} 個${holes > 0 ? `（穴 ${holes} 個）` : ''}`;
	ui.statVertices.textContent = geometry.attributes.position.count.toLocaleString('ja-JP');
	ui.statFaces.textContent = (geometry.attributes.position.count / 3).toLocaleString('ja-JP');

	ui.stats.hidden = false;
	ui.placeholder.hidden = true;
	ui.download.disabled = false;

	ui.scaleNote.textContent =
		ui.scaleMode.value === 'auto' && parsed.scale ? parsed.scale.source : `1単位 = ${formatNumber(scale)} mm`;

	messages.unshift({ text: `変換しました（1単位 = ${formatNumber(scale)} mm）。`, tone: 'ok' });
	showMessages(messages);
}

function reset() {
	viewer.clear();
	geometry = null;
	ui.stats.hidden = true;
	ui.placeholder.hidden = false;
	ui.download.disabled = true;
}

async function loadFile(file) {
	if (!file) return;

	const ext = file.name.split('.').pop().toLowerCase();

	if (ext !== 'svg' && ext !== 'dxf') {
		showMessages([{ text: 'SVG または DXF ファイルを選んでください。', tone: 'error' }]);
		return;
	}

	source = { kind: ext, text: await file.text(), name: file.name, parsed: null };

	ui.filename.textContent = file.name;
	ui.filename.hidden = false;
	ui.holeModeField.hidden = ext !== 'svg';

	rebuild();
}

/** 解析結果を破棄して作り直す（分割数・穴の判定など、パース結果に影響する変更） */
function reparse() {
	if (!source) return;

	source.parsed = null;
	rebuild();
}

/** スライダーや数値入力の連打で重い再計算が詰まらないようにまとめる */
function debounce(fn, wait = 120) {
	let timer = 0;

	return () => {
		clearTimeout(timer);
		timer = setTimeout(fn, wait);
	};
}

const rebuildSoon = debounce(rebuild);
const reparseSoon = debounce(reparse);

function download() {
	if (!geometry || !source) return;

	const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
	const data = exporter.parse(mesh, { binary: true });
	const blob = new Blob([data.buffer ?? data], { type: 'model/stl' });
	const url = URL.createObjectURL(blob);

	const link = document.createElement('a');
	link.href = url;
	link.download = `${source.name.replace(/\.[^.]+$/, '')}_extruded.stl`;
	link.click();

	URL.revokeObjectURL(url);
	mesh.material.dispose();
}

// --- イベント配線 ---

ui.drop.addEventListener('click', () => ui.file.click());
ui.drop.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		ui.file.click();
	}
});

ui.file.addEventListener('change', () => loadFile(ui.file.files[0]));

for (const type of ['dragenter', 'dragover']) {
	ui.drop.addEventListener(type, (event) => {
		event.preventDefault();
		ui.drop.classList.add('is-over');
	});
}

for (const type of ['dragleave', 'dragend', 'drop']) {
	ui.drop.addEventListener(type, () => ui.drop.classList.remove('is-over'));
}

ui.drop.addEventListener('drop', (event) => {
	event.preventDefault();
	loadFile(event.dataTransfer?.files?.[0]);
});

// ページ全体へのドロップも受け付ける
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
	event.preventDefault();
	loadFile(event.dataTransfer?.files?.[0]);
});

ui.thickness.addEventListener('input', rebuildSoon);
ui.center.addEventListener('change', rebuild);
ui.scaleValue.addEventListener('input', rebuildSoon);
ui.holeMode.addEventListener('change', reparse);

ui.segments.addEventListener('input', () => {
	ui.segmentsOut.textContent = ui.segments.value;
	reparseSoon();
});

ui.scaleMode.addEventListener('change', () => {
	const mode = ui.scaleMode.value;
	ui.scaleValue.hidden = mode === 'auto';

	if (mode === 'manual') ui.scaleValue.value = '1';
	if (mode === 'width' || mode === 'height') ui.scaleValue.value = '100';

	rebuild();
});

ui.edges.addEventListener('change', () => viewer.setEdgesVisible(ui.edges.checked));
ui.download.addEventListener('click', download);

import {
	OP_LABELS,
	SHAPE_LABELS,
	contourToPathData,
	contoursToPathData,
	createNode,
	createShape,
	shapeBounds,
	shapeCenter,
	shapeFields,
	shapeFromDrag,
	shapeToContours,
	getDefaultHeight,
	scaleShape,
	translateShape
} from './editor-shapes.js';
import { shapesToBands, shapeTop } from './solid.js';
import { DEFAULT_FONT_KEY, buildTextContours, getFont } from './fonts.js';

const NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'curve-extrusion:shapes';

// 2Dプレビューのブーリアンは軽さ優先で粗めに刻む（押し出しは設定どおりの分割数で行う）
const PREVIEW_SEGMENTS = 16;

function svgEl(tag, attrs = {}) {
	const node = document.createElementNS(NS, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	return node;
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function distance(ax, ay, bx, by) {
	return Math.hypot(ax - bx, ay - by);
}

export class Editor {
	constructor(refs, { onChange } = {}) {
		this.refs = refs;
		this.onChange = onChange ?? (() => {});

		this.shapes = [];
		this.selectedId = null;
		this.tool = 'select';
		this.snap = 1;
		this.view = { x: -20, y: -20, scale: 4 };

		this.drag = null;
		this.pen = null;
		this.undoStack = [];

		this.scene = svgEl('g');
		this.gridLayer = svgEl('g', { 'pointer-events': 'none' });
		this.resultLayer = svgEl('g', { 'pointer-events': 'none' });
		this.outlineLayer = svgEl('g');
		this.overlayLayer = svgEl('g');

		this.scene.append(this.gridLayer, this.resultLayer, this.outlineLayer, this.overlayLayer);
		refs.svg.append(this.scene);

		this.bindTools();
		this.bindPointer();
		this.bindKeyboard();

		this.restore();
		this.render();
	}

	// --- 状態 ---

	get selected() {
		return this.byId(this.selectedId);
	}

	byId(id) {
		return this.shapes.find((shape) => shape.id === id) ?? null;
	}

	snapshot() {
		return JSON.stringify({ shapes: this.shapes, selectedId: this.selectedId });
	}

	pushSnapshot(snapshot) {
		this.undoStack.push(snapshot);
		if (this.undoStack.length > 60) this.undoStack.shift();
	}

	pushUndo() {
		this.pushSnapshot(this.snapshot());
	}

	/**
	 * ドラッグが実際に形を変えたときだけ取り消し履歴を積む。
	 * 選択するだけのクリックで履歴が埋まるのを防ぐ。
	 */
	markDirty(drag) {
		if (drag.dirty) return;

		drag.dirty = true;
		this.pushSnapshot(drag.snapshot);
	}

	undo() {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;

		const state = JSON.parse(snapshot);
		this.shapes = state.shapes;
		this.selectedId = state.selectedId;
		this.changed();
	}

	/** 図形が変わったときの共通処理（再描画・保存・3D更新の通知） */
	changed() {
		this.render();
		this.save();
		this.onChange();
	}

	save() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shapes));
		} catch {
			// 保存できなくても編集は続けられるので無視する
		}
	}

	restore() {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
			if (Array.isArray(saved) && saved.length > 0) {
				this.shapes = saved;
				// 復元した図形と新規作成の id が衝突しないよう、続きの番号から振り直す
				let max = 0;
				for (const shape of this.shapes) max = Math.max(max, shape.id ?? 0);

				for (const shape of this.shapes) {
					if (!shape.id) shape.id = ++max;
					// Z 範囲を持たない古い保存データを補う
					shape.z ??= 0;
					shape.height ??= getDefaultHeight();
				}
			}
		} catch {
			this.shapes = [];
		}
	}

	clearAll() {
		if (this.shapes.length === 0) return;

		this.pushUndo();
		this.shapes = [];
		this.selectedId = null;
		this.changed();
	}

	toBands(curveSegments) {
		return shapesToBands(this.shapes, curveSegments);
	}

	/**
	 * 選んだ図形の Z 範囲を、その下にある図形に合わせて設定する。
	 * 数値を意識せずに浮き出し・彫り込み・貫通を切り替えられるようにするため。
	 */
	applyZPreset(id, preset) {
		const shape = this.byId(id);
		if (!shape) return;

		this.pushUndo();

		// どれも「下にある図形に対して」の操作なので、演算順でも一番手前へ移す。
		// 文字を置いてから板を描いた場合、そのままでは文字が土台になり演算が効かない。
		const index = this.indexOf(id);
		if (index >= 0 && index !== this.shapes.length - 1) {
			this.shapes.splice(index, 1);
			this.shapes.push(shape);
		}

		const below = this.shapes.slice(0, -1).filter((s) => !s.hidden);
		const top = below.length > 0 ? Math.max(...below.map(shapeTop)) : 0;
		const bottom = below.length > 0 ? Math.min(...below.map((s) => s.z)) : 0;

		if (preset === 'raise') {
			shape.z = top;
			shape.op = 'union';
		} else if (preset === 'engrave') {
			const depth = Math.max(0.2, Math.min(shape.height, 1));
			shape.z = top - depth;
			shape.height = depth;
			shape.op = 'subtract';
		} else {
			shape.z = bottom;
			shape.height = Math.max(top - bottom, 0.2);
			shape.op = 'subtract';
		}

		this.changed();
	}

	// --- 文字 ---

	/**
	 * 文字の輪郭を作り直す。輪郭は em 単位で持つので、
	 * 移動・拡大・回転だけならフォントが無くても後から編集できる。
	 */
	rebakeText(shape) {
		const entry = getFont(shape.fontKey) ?? getFont(DEFAULT_FONT_KEY);

		if (!entry) {
			this.refs.onFontMissing?.();
			return false;
		}

		const { contours, missing } = buildTextContours(entry.font, {
			text: shape.text,
			tracking: shape.tracking,
			lineHeight: shape.lineHeight,
			align: shape.align
		});

		shape.fontKey = entry.key;
		shape.fontName = entry.name;
		shape.contours = contours;
		shape.missing = missing;

		return true;
	}

	/** 文字ツールのクリック。フォントが来るまで待ってから置く */
	async placeText(point) {
		const ready = await (this.refs.ensureFonts?.() ?? Promise.resolve(Boolean(getFont(DEFAULT_FONT_KEY))));
		if (!ready) return;

		this.addText(point, this.refs.fontSelect?.value || DEFAULT_FONT_KEY);
	}

	addText(point, fontKey) {
		const shape = createShape('text', {
			text: '文字',
			x: point[0],
			y: point[1],
			size: 20,
			tracking: 0,
			lineHeight: 1.3,
			align: 'left',
			fontKey
		});

		// 輪郭を作れないまま置くと、見えない空の図形が残ってしまう
		if (!this.rebakeText(shape)) return;

		this.pushUndo();
		this.shapes.push(shape);
		this.selectedId = shape.id;
		this.tool = 'select';
		this.changed();

		// すぐ打ち替えられるように文字列の入力欄へフォーカスする
		this.refs.properties.querySelector('textarea')?.focus();
	}

	/** フォントが後から読めたときに、輪郭が空のままの文字を作り直す */
	refreshTextShapes() {
		let updated = false;

		for (const shape of this.shapes) {
			if (shape.kind !== 'text' || shape.contours?.length) continue;
			if (this.rebakeText(shape)) updated = true;
		}

		if (updated) this.changed();
		else this.render();
	}

	/** フォントを差し替えて、その文字図形を作り直す */
	setShapeFont(id, fontKey) {
		const shape = this.byId(id);
		if (!shape || shape.kind !== 'text') return;

		this.pushUndo();
		shape.fontKey = fontKey;
		this.rebakeText(shape);
		this.changed();
	}

	/**
	 * 一番下の図形は土台になるため、そこに指定した演算は効かない。
	 * 黙って無視されると原因が分からないので、警告文を返す。
	 */
	baseOpWarning() {
		const base = this.shapes.find((shape) => !shape.hidden);
		if (!base || base.op === 'union') return null;

		return `一番下の「${SHAPE_LABELS[base.kind]} ${base.id}」は土台になるため「${OP_LABELS[base.op]}」が効きません。↑ で手前に移動するか、下に土台となる図形を追加してください。`;
	}

	/** 現在フォントに無い文字を集める（警告表示用） */
	missingGlyphs() {
		const missing = new Set();

		for (const shape of this.shapes) {
			for (const char of shape.missing ?? []) missing.add(char);
		}

		return [...missing];
	}

	// --- 座標変換 ---

	toWorld(event) {
		const rect = this.refs.svg.getBoundingClientRect();

		return [
			(event.clientX - rect.left) / this.view.scale + this.view.x,
			(event.clientY - rect.top) / this.view.scale + this.view.y
		];
	}

	snapPoint([x, y], event) {
		// スナップは Alt を押している間だけ無効化する
		if (!this.snap || event?.altKey) return [x, y];

		return [Math.round(x / this.snap) * this.snap, Math.round(y / this.snap) * this.snap];
	}

	fitView() {
		const boxes = this.shapes.map((shape) => shapeBounds(shape)).filter(Boolean);
		const rect = this.refs.svg.getBoundingClientRect();

		if (boxes.length === 0) {
			this.view = { x: -10, y: -10, scale: 4 };
		} else {
			const minX = Math.min(...boxes.map((b) => b.minX));
			const minY = Math.min(...boxes.map((b) => b.minY));
			const maxX = Math.max(...boxes.map((b) => b.maxX));
			const maxY = Math.max(...boxes.map((b) => b.maxY));
			const margin = 0.12;
			const scale = Math.min(rect.width / (maxX - minX || 1), rect.height / (maxY - minY || 1)) * (1 - margin * 2);

			this.view = {
				scale,
				x: (minX + maxX) / 2 - rect.width / 2 / scale,
				y: (minY + maxY) / 2 - rect.height / 2 / scale
			};
		}

		this.render();
	}

	// --- 描画 ---

	render() {
		this.scene.setAttribute('transform', `scale(${this.view.scale}) translate(${-this.view.x} ${-this.view.y})`);

		this.renderGrid();
		this.renderResult();
		this.renderOutlines();
		this.renderOverlay();
		this.renderLayers();
		this.renderProperties();
		this.renderToolState();

		this.refs.hint.textContent = this.hintText();
	}

	renderGrid() {
		this.gridLayer.replaceChildren();

		const rect = this.refs.svg.getBoundingClientRect();
		const scale = this.view.scale;
		const left = this.view.x;
		const top = this.view.y;
		const right = left + rect.width / scale;
		const bottom = top + rect.height / scale;

		// 画面上で 8px 以上になる最小の「1・2・5×10ⁿ」を目盛り間隔にする
		const raw = 8 / scale;
		const pow = Math.pow(10, Math.floor(Math.log10(raw)));
		const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) ?? pow * 10;

		const minor = [];
		const major = [];

		for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
			const target = Math.abs(x % (step * 10)) < step / 2 ? major : minor;
			target.push(`M${x} ${top}V${bottom}`);
		}

		for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
			const target = Math.abs(y % (step * 10)) < step / 2 ? major : minor;
			target.push(`M${left} ${y}H${right}`);
		}

		this.gridLayer.append(
			svgEl('path', { d: minor.join(''), stroke: '#243244', 'stroke-width': 1 / scale, fill: 'none' }),
			svgEl('path', { d: major.join(''), stroke: '#31465e', 'stroke-width': 1 / scale, fill: 'none' }),
			// 原点の十字
			svgEl('path', {
				d: `M${left} 0H${right}M0 ${top}V0M0 0V${bottom}`,
				stroke: '#4a6785',
				'stroke-width': 1.4 / scale,
				fill: 'none'
			})
		);

		this.refs.gridLabel.textContent = `グリッド ${step >= 1 ? step : step.toFixed(2)} mm`;
	}

	renderResult() {
		this.resultLayer.replaceChildren();

		const bands = this.toBands(PREVIEW_SEGMENTS);
		if (bands.length === 0) return;

		const ring = (points) => `M${points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join('L')}Z`;

		// 帯を重ねて塗ることで、段が積み上がっている様子が見える
		for (const band of bands) {
			const d = band.regions.map((region) => ring(region.contour) + region.holes.map(ring).join('')).join('');

			this.resultLayer.append(
				svgEl('path', { d, fill: '#6aa9ff', 'fill-opacity': 0.16, 'fill-rule': 'evenodd' }),
				svgEl('path', {
					d,
					fill: 'none',
					stroke: '#6aa9ff',
					'stroke-width': 1.4 / this.view.scale,
					'stroke-opacity': 0.8,
					'fill-rule': 'evenodd'
				})
			);
		}
	}

	renderOutlines() {
		this.outlineLayer.replaceChildren();

		for (const shape of this.shapes) {
			const d = contoursToPathData(shapeToContours(shape));
			if (!d) continue;

			const selected = shape.id === this.selectedId;
			const subtractive = shape.op === 'subtract' || shape.op === 'xor';

			const path = svgEl('path', {
				d,
				fill: 'none',
				'pointer-events': 'all',
				stroke: selected ? '#ffd166' : subtractive ? '#ff8f8f' : '#7f9bbb',
				'stroke-width': (selected ? 1.8 : 1.1) / this.view.scale,
				'stroke-dasharray': subtractive ? `${4 / this.view.scale} ${3 / this.view.scale}` : 'none',
				opacity: shape.hidden ? 0.25 : 1
			});

			path.dataset.shapeId = shape.id;
			path.style.cursor = 'move';
			this.outlineLayer.append(path);
		}
	}

	renderOverlay() {
		this.overlayLayer.replaceChildren();

		if (this.pen) this.renderPenPreview();

		const shape = this.selected;
		if (!shape || this.pen) return;

		if (this.tool === 'node' && shape.kind === 'path') this.renderNodeHandles(shape);
		else this.renderTransformHandles(shape);
	}

	renderTransformHandles(shape) {
		const box = shapeBounds(shape);
		if (!box) return;

		const scale = this.view.scale;
		const size = 7 / scale;

		this.overlayLayer.append(
			svgEl('rect', {
				x: box.minX,
				y: box.minY,
				width: box.maxX - box.minX,
				height: box.maxY - box.minY,
				fill: 'none',
				stroke: '#ffd166',
				'stroke-width': 1 / scale,
				'stroke-dasharray': `${3 / scale} ${3 / scale}`,
				'pointer-events': 'none'
			})
		);

		const corners = [
			['nw', box.minX, box.minY],
			['ne', box.maxX, box.minY],
			['se', box.maxX, box.maxY],
			['sw', box.minX, box.maxY]
		];

		for (const [name, x, y] of corners) {
			const handle = svgEl('rect', {
				x: x - size / 2,
				y: y - size / 2,
				width: size,
				height: size,
				fill: '#ffd166',
				stroke: '#1b2735',
				'stroke-width': 1 / scale
			});

			handle.dataset.handle = 'scale';
			handle.dataset.corner = name;
			handle.style.cursor = name === 'nw' || name === 'se' ? 'nwse-resize' : 'nesw-resize';
			this.overlayLayer.append(handle);
		}

		// 回転ハンドルは上辺の外側に置く
		const cx = (box.minX + box.maxX) / 2;
		const ry = box.minY - 26 / scale;

		this.overlayLayer.append(
			svgEl('line', {
				x1: cx,
				y1: box.minY,
				x2: cx,
				y2: ry,
				stroke: '#ffd166',
				'stroke-width': 1 / scale,
				'pointer-events': 'none'
			})
		);

		const rotateHandle = svgEl('circle', {
			cx,
			cy: ry,
			r: size / 1.6,
			fill: '#1b2735',
			stroke: '#ffd166',
			'stroke-width': 1.6 / scale
		});

		rotateHandle.dataset.handle = 'rotate';
		rotateHandle.style.cursor = 'grab';
		this.overlayLayer.append(rotateHandle);
	}

	renderNodeHandles(shape) {
		const scale = this.view.scale;
		const r = 4.5 / scale;

		shape.nodes.forEach((node, index) => {
			for (const [kind, hx, hy] of [
				['in', node.inX, node.inY],
				['out', node.outX, node.outY]
			]) {
				if (hx === node.x && hy === node.y) continue;

				this.overlayLayer.append(
					svgEl('line', {
						x1: node.x,
						y1: node.y,
						x2: hx,
						y2: hy,
						stroke: '#8fb8ff',
						'stroke-width': 1 / scale,
						'pointer-events': 'none'
					})
				);

				const handle = svgEl('circle', { cx: hx, cy: hy, r: r * 0.8, fill: '#8fb8ff' });
				handle.dataset.handle = kind;
				handle.dataset.index = index;
				handle.style.cursor = 'crosshair';
				this.overlayLayer.append(handle);
			}

			const anchor = svgEl('rect', {
				x: node.x - r,
				y: node.y - r,
				width: r * 2,
				height: r * 2,
				fill: '#ffd166',
				stroke: '#1b2735',
				'stroke-width': 1 / scale
			});

			anchor.dataset.handle = 'anchor';
			anchor.dataset.index = index;
			anchor.style.cursor = 'move';
			this.overlayLayer.append(anchor);
		});
	}

	renderPenPreview() {
		const scale = this.view.scale;
		const nodes = this.pen.nodes;
		if (nodes.length === 0) return;

		const preview = { kind: 'path', nodes, rotation: 0 };
		const [contour] = nodes.length >= 2 ? shapeToContours(preview) : [];

		if (contour) {
			this.overlayLayer.append(
				svgEl('path', {
					d: contourToPathData(contour),
					fill: '#ffd166',
					'fill-opacity': 0.1,
					stroke: '#ffd166',
					'stroke-width': 1.4 / scale,
					'pointer-events': 'none'
				})
			);
		}

		nodes.forEach((node, index) => {
			this.overlayLayer.append(
				svgEl('circle', {
					cx: node.x,
					cy: node.y,
					r: (index === 0 ? 6 : 4) / scale,
					fill: index === 0 ? '#ffd166' : '#1b2735',
					stroke: '#ffd166',
					'stroke-width': 1.4 / scale,
					'pointer-events': 'none'
				})
			);
		});
	}

	// --- サイドバー ---

	renderLayers() {
		const list = this.refs.layers;

		// 並び順が同じなら作り直さず中身だけ更新する。
		// フォーカス中の <select> を含む要素を差し替えると例外になるため。
		const signature = this.shapes.map((shape) => shape.id).join(',');

		if (signature === this.layerSignature && signature !== '') {
			this.updateLayerRows();
			return;
		}

		this.layerSignature = signature;
		this.layerRows = new Map();
		list.replaceChildren();

		if (this.shapes.length === 0) {
			list.append(el('p', 'note', 'ツールを選んでキャンバスにドラッグすると図形が追加されます。'));
			return;
		}

		// 手前（最後に適用される図形）を上に表示する
		[...this.shapes].reverse().forEach((shape, reversedIndex) => {
			const index = this.shapes.length - 1 - reversedIndex;
			const id = shape.id;
			const row = el('div', `layer${id === this.selectedId ? ' is-selected' : ''}`);

			const pick = el('button', 'layer-name', `${SHAPE_LABELS[shape.kind]} ${id}`);
			pick.type = 'button';
			pick.addEventListener('click', () => {
				this.selectedId = id;
				this.render();
			});

			const op = el('select', 'layer-op');
			for (const [value, label] of Object.entries(OP_LABELS)) {
				const option = el('option', null, label);
				option.value = value;
				op.append(option);
			}

			// 一番下の図形は土台。演算子を表示したままだと「効いている」ように見えるので置き換える
			if (index === 0) {
				const base = el('option', null, '土台（演算なし）');
				base.value = '';
				op.append(base);
				op.value = '';
				op.disabled = true;
				op.title = '一番下の図形は土台になります。演算をかけたい図形は ↑ で手前に移動してください';
			} else {
				op.value = shape.op;
				op.title = 'ひとつ下までの結果に対する演算';
			}
			op.addEventListener('change', () => {
				const target = this.byId(id);
				if (!target) return;

				this.pushUndo();
				target.op = op.value;
				this.changed();
			});

			const buttons = el('div', 'layer-actions');

			const mkButton = (label, title, handler, disabled = false) => {
				const button = el('button', null, label);
				button.type = 'button';
				button.title = title;
				button.disabled = disabled;
				button.addEventListener('click', handler);
				return button;
			};

			buttons.append(
				mkButton(shape.hidden ? '◻' : '◼', '表示/非表示', () => {
					const target = this.byId(id);
					if (!target) return;

					this.pushUndo();
					target.hidden = !target.hidden;
					this.changed();
				}),
				mkButton('↑', '手前へ', () => this.reorder(this.indexOf(id), 1), index === this.shapes.length - 1),
				mkButton('↓', '奥へ', () => this.reorder(this.indexOf(id), -1), index === 0),
				mkButton('✕', '削除', () => this.remove(id))
			);

			row.append(pick, op, buttons);
			list.append(row);
			this.layerRows.set(shape.id, { row, op, visibility: buttons.firstChild });
		});
	}

	updateLayerRows() {
		for (const shape of this.shapes) {
			const parts = this.layerRows.get(shape.id);
			if (!parts) continue;

			parts.row.classList.toggle('is-selected', shape.id === this.selectedId);
			parts.visibility.textContent = shape.hidden ? '◻' : '◼';
			if (document.activeElement !== parts.op && !parts.op.disabled) parts.op.value = shape.op;
		}
	}

	renderProperties() {
		const panel = this.refs.properties;
		const shape = this.selected;

		// 項目の顔ぶれが変わらない限り作り直さない。
		// 入力中の <input> ごと差し替えるとフォーカスが飛び、例外にもなるため。
		const signature = shape ? `${shape.id}:${shape.kind}:${shape.nodes?.length ?? 0}` : 'none';

		if (signature === this.propsSignature) {
			this.updatePropertyValues(shape);
			return;
		}

		this.propsSignature = signature;
		this.propInputs = [];
		panel.replaceChildren();

		const shapeId = shape?.id;

		if (!shape) {
			panel.append(el('p', 'note', '図形を選ぶとサイズを数値で指定できます。'));
			return;
		}

		if (shape.kind === 'path') {
			panel.append(el('p', 'note', `ノード ${shape.nodes.length} 個。「ノード」ツールで頂点とハンドルを編集できます。`));
		}

		if (shape.kind === 'text') {
			panel.append(this.buildFontRow(shape));
		}

		panel.append(this.buildZPresets(shapeId));

		const grid = el('div', 'prop-grid');

		for (const field of shapeFields(shape)) {
			const wrap = el('label', `prop${field.type === 'text' ? ' prop-wide' : ''}`);
			wrap.append(el('span', null, field.unit ? `${field.label} (${field.unit})` : field.label));

			// 変更を図形へ書き戻す。オブジェクトは差し替わりうるので毎回 id で引き直す
			const apply = (mutate) => {
				const target = this.byId(shapeId);
				if (!target) return;

				this.pushUndo();
				mutate(target);
				if (field.rebake) this.rebakeText(target);
				this.changed();
			};

			if (field.type === 'text') {
				const area = el('textarea');
				area.rows = 2;
				area.value = shape[field.key] ?? '';
				area.addEventListener('input', () => apply((target) => (target[field.key] = area.value)));

				wrap.append(area);
				grid.append(wrap);
				this.propInputs.push({ input: area, field, toDisplay: (v) => v, raw: true });
				continue;
			}

			if (field.type === 'select') {
				const select = el('select');

				for (const [value, label] of field.choices) {
					const option = el('option', null, label);
					option.value = value;
					select.append(option);
				}

				select.value = shape[field.key];
				select.addEventListener('change', () => apply((target) => (target[field.key] = select.value)));

				wrap.append(select);
				grid.append(wrap);
				this.propInputs.push({ input: select, field, toDisplay: (v) => v, raw: true });
				continue;
			}

			const input = el('input');
			input.type = 'number';
			input.step = field.step ?? 1;
			if (field.min !== undefined) input.min = field.min;
			if (field.max !== undefined) input.max = field.max;

			const toDisplay = (v) => (field.angle ? (v * 180) / Math.PI : v);
			const fromDisplay = (v) => (field.angle ? (v * Math.PI) / 180 : v);

			input.value = Number(toDisplay(shape[field.key] ?? 0).toFixed(field.integer ? 0 : 3));

			input.addEventListener('change', () => {
				let value = fromDisplay(Number(input.value));
				if (!Number.isFinite(value)) return;
				if (field.integer) value = Math.round(value);
				if (field.min !== undefined) value = Math.max(fromDisplay(field.min), value);
				if (field.max !== undefined) value = Math.min(fromDisplay(field.max), value);

				apply((target) => (target[field.key] = value));
			});

			wrap.append(input);
			grid.append(wrap);
			this.propInputs.push({ input, field, toDisplay });
		}

		panel.append(grid);
	}

	/** Z 範囲のかんたん設定（下の図形の高さを見て自動で合わせる） */
	buildZPresets(id) {
		const row = el('div', 'presets');
		row.append(el('span', 'presets-label', '配置'));

		for (const [preset, label, title] of [
			['raise', '浮き出し', '下の図形の上に乗せる'],
			['engrave', '彫り込み', '下の図形の表面を彫る（底が残るので抜け落ちない）'],
			['through', '貫通', '下の図形を貫いて切り抜く']
		]) {
			const button = el('button', 'mini', label);
			button.type = 'button';
			button.title = title;
			button.addEventListener('click', () => this.applyZPreset(id, preset));
			row.append(button);
		}

		return row;
	}

	/** 文字図形のフォント選択行 */
	buildFontRow(shape) {
		const wrap = el('label', 'prop prop-wide');
		wrap.append(el('span', null, 'フォント'));

		const select = el('select');
		const id = shape.id;

		for (const entry of this.refs.fontEntries()) {
			const option = el('option', null, entry.name);
			option.value = entry.key;
			select.append(option);
		}

		select.value = shape.fontKey;
		select.addEventListener('change', () => this.setShapeFont(id, select.value));

		wrap.append(select);

		return wrap;
	}

	updatePropertyValues(shape) {
		if (!shape) return;

		for (const { input, field, toDisplay, raw } of this.propInputs ?? []) {
			// 入力中の欄は書き換えない
			if (document.activeElement === input) continue;

			input.value = raw ? (shape[field.key] ?? '') : Number(toDisplay(shape[field.key] ?? 0).toFixed(field.integer ? 0 : 3));
		}
	}

	renderToolState() {
		for (const button of this.refs.tools.querySelectorAll('[data-tool]')) {
			button.classList.toggle('is-active', button.dataset.tool === this.tool);
		}
	}

	hintText() {
		if (this.pen) return 'クリックで頂点、ドラッグで曲線。最初の点をクリック（または Enter）で閉じる、Esc で取り消し。';

		switch (this.tool) {
			case 'select':
				return '図形をクリックで選択、ドラッグで移動。背景ドラッグで表示移動、ホイールで拡大縮小。';
			case 'node':
				return 'パスを選ぶと頂点とハンドルを編集できます。ハンドルは Alt でハンドルを分離、ダブルクリックで角と曲線を切替。';
			case 'pen':
				return 'クリックで頂点、ドラッグで曲線を描きます。';
			case 'text':
				return 'クリックした位置に文字を置きます。文字列やサイズは右の「プロパティ」で変更できます。';
			default:
				return 'キャンバスをドラッグして図形を作成します。Alt でスナップを一時解除。';
		}
	}

	// --- 操作 ---

	indexOf(id) {
		return this.shapes.findIndex((shape) => shape.id === id);
	}

	reorder(index, direction) {
		const target = index + direction;
		if (index < 0 || target < 0 || target >= this.shapes.length) return;

		this.pushUndo();
		const [shape] = this.shapes.splice(index, 1);
		this.shapes.splice(target, 0, shape);
		this.changed();
	}

	remove(id) {
		const index = this.shapes.findIndex((shape) => shape.id === id);
		if (index < 0) return;

		this.pushUndo();
		this.shapes.splice(index, 1);
		if (this.selectedId === id) this.selectedId = null;
		this.changed();
	}

	duplicate() {
		const shape = this.selected;
		if (!shape) return;

		this.pushUndo();
		const copy = JSON.parse(JSON.stringify(shape));
		copy.id = Math.max(0, ...this.shapes.map((s) => s.id)) + 1;
		translateShape(copy, 2, 2);
		this.shapes.push(copy);
		this.selectedId = copy.id;
		this.changed();
	}

	setTool(tool) {
		if (this.pen) this.finishPen(false);

		// 置く前から取りに行っておくと、クリック時の待ちが短くなる
		if (tool === 'text') this.refs.ensureFonts?.();

		this.tool = tool;
		this.render();
	}

	bindTools() {
		this.refs.tools.addEventListener('click', (event) => {
			const button = event.target.closest('[data-tool]');
			if (button) this.setTool(button.dataset.tool);
		});
	}

	// --- ペンツール ---

	startPen(point) {
		this.pen = { nodes: [createNode(point[0], point[1])] };
	}

	finishPen(commit) {
		const nodes = this.pen?.nodes ?? [];
		this.pen = null;

		if (commit && nodes.length >= 3) {
			this.pushUndo();
			const shape = createShape('path', { nodes });
			this.shapes.push(shape);
			this.selectedId = shape.id;
			this.tool = 'select';
			this.changed();
			return;
		}

		this.render();
	}

	// --- ポインタ操作 ---

	bindPointer() {
		const svg = this.refs.svg;

		svg.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		svg.addEventListener('pointermove', (event) => this.onPointerMove(event));
		svg.addEventListener('pointerup', (event) => this.onPointerUp(event));
		svg.addEventListener('contextmenu', (event) => event.preventDefault());

		svg.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();

				const [wx, wy] = this.toWorld(event);
				const factor = Math.exp(-event.deltaY * 0.0015);
				const scale = Math.min(400, Math.max(0.2, this.view.scale * factor));

				// カーソル位置のワールド座標が動かないように原点を補正する
				const rect = svg.getBoundingClientRect();
				this.view.x = wx - (event.clientX - rect.left) / scale;
				this.view.y = wy - (event.clientY - rect.top) / scale;
				this.view.scale = scale;

				this.render();
			},
			{ passive: false }
		);
	}

	onPointerDown(event) {
		if (event.button === 1 || event.buttons === 4) {
			this.drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, view: { ...this.view } };
			this.refs.svg.setPointerCapture(event.pointerId);
			return;
		}

		if (event.button !== 0) return;

		const raw = this.toWorld(event);
		const point = this.snapPoint(raw, event);
		this.refs.svg.setPointerCapture(event.pointerId);

		if (this.tool === 'pen') {
			this.onPenDown(raw, point);
			return;
		}

		if (this.tool === 'text') {
			this.drag = null;
			this.placeText(point);
			return;
		}

		const handle = event.target.dataset?.handle;

		if (handle) {
			this.onHandleDown(handle, event, raw);
			return;
		}

		const shapeId = event.target.dataset?.shapeId;

		if (this.tool === 'select' || this.tool === 'node') {
			if (shapeId) {
				this.selectedId = Number(shapeId);
				const shape = this.selected;
				this.drag = {
					mode: 'move',
					start: point,
					origin: JSON.parse(JSON.stringify(shape)),
					shape,
					snapshot: this.snapshot()
				};
				this.render();
			} else {
				this.selectedId = null;
				this.drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, view: { ...this.view } };
				this.render();
			}
			return;
		}

		// 図形作成ツール
		this.drag = { mode: 'create', start: point, kind: this.tool, shape: null };
	}

	onPenDown(raw, point) {
		if (!this.pen) {
			this.startPen(point);
			this.drag = { mode: 'pen-handle', node: this.pen.nodes[0] };
			this.render();
			return;
		}

		const first = this.pen.nodes[0];
		const threshold = 8 / this.view.scale;

		if (this.pen.nodes.length >= 3 && distance(raw[0], raw[1], first.x, first.y) <= threshold) {
			this.finishPen(true);
			return;
		}

		const node = createNode(point[0], point[1]);
		this.pen.nodes.push(node);
		this.drag = { mode: 'pen-handle', node };
		this.render();
	}

	onHandleDown(handle, event, raw) {
		const shape = this.selected;
		if (!shape) return;

		const snapshot = this.snapshot();

		if (handle === 'anchor') {
			const index = Number(event.target.dataset.index);
			const now = performance.now();
			const previous = this.lastAnchorClick;

			// ドラッグのたびにオーバーレイを作り直すため dblclick イベントは頼れない。
			// 同じアンカーへの連続クリックを自前で判定する。
			if (previous && previous.index === index && now - previous.time < 350) {
				this.lastAnchorClick = null;
				this.toggleNodeSmooth(shape, index);
				return;
			}

			this.lastAnchorClick = { index, time: now };
		}

		if (handle === 'scale') {
			const box = shapeBounds(shape);
			const corner = event.target.dataset.corner;
			// ドラッグする角の対角を固定点にする
			const anchor = [
				corner === 'nw' || corner === 'sw' ? box.maxX : box.minX,
				corner === 'nw' || corner === 'ne' ? box.maxY : box.minY
			];

			this.drag = {
				mode: 'scale',
				shape,
				anchor,
				startDistance: Math.max(distance(raw[0], raw[1], anchor[0], anchor[1]), 1e-6),
				origin: JSON.parse(JSON.stringify(shape)),
				snapshot
			};
			return;
		}

		if (handle === 'rotate') {
			const center = shapeCenter(shape);
			this.drag = {
				mode: 'rotate',
				shape,
				center,
				startAngle: Math.atan2(raw[1] - center[1], raw[0] - center[0]),
				startRotation: shape.rotation ?? 0,
				snapshot
			};
			return;
		}

		this.drag = { mode: handle, shape, index: Number(event.target.dataset.index), snapshot };
	}

	onPointerMove(event) {
		const drag = this.drag;
		if (!drag) return;

		if (drag.mode === 'pan') {
			this.view.x = drag.view.x - (event.clientX - drag.startX) / this.view.scale;
			this.view.y = drag.view.y - (event.clientY - drag.startY) / this.view.scale;
			this.render();
			return;
		}

		const raw = this.toWorld(event);
		const point = this.snapPoint(raw, event);

		switch (drag.mode) {
			case 'pen-handle': {
				// 押したまま動かすと、その方向にハンドルが伸びて曲線になる
				const node = drag.node;
				node.outX = raw[0];
				node.outY = raw[1];
				node.inX = 2 * node.x - raw[0];
				node.inY = 2 * node.y - raw[1];
				this.render();
				return;
			}

			case 'create': {
				const options = drag.kind === 'polygon' ? { sides: 6 } : { points: 5, innerRatio: 0.5 };
				const shape = shapeFromDrag(drag.kind, drag.start[0], drag.start[1], point[0], point[1], options);
				if (!shape) return;

				if (drag.shape) shape.id = drag.shape.id;
				drag.shape = shape;

				const preview = this.shapes.filter((s) => s.id !== shape.id);
				this.shapes = [...preview, shape];
				this.selectedId = shape.id;
				this.render();
				return;
			}

			case 'move': {
				this.markDirty(drag);
				const shape = drag.shape;
				Object.assign(shape, JSON.parse(JSON.stringify(drag.origin)));
				translateShape(shape, point[0] - drag.start[0], point[1] - drag.start[1]);
				this.render();
				return;
			}

			case 'scale': {
				this.markDirty(drag);
				const shape = drag.shape;
				Object.assign(shape, JSON.parse(JSON.stringify(drag.origin)));
				const factor = distance(raw[0], raw[1], drag.anchor[0], drag.anchor[1]) / drag.startDistance;
				scaleShape(shape, Math.max(factor, 0.01), drag.anchor);
				this.render();
				return;
			}

			case 'rotate': {
				this.markDirty(drag);
				const angle = Math.atan2(raw[1] - drag.center[1], raw[0] - drag.center[0]);
				let rotation = drag.startRotation + (angle - drag.startAngle);
				// Shift で15度刻み
				if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
				drag.shape.rotation = rotation;
				this.render();
				return;
			}

			case 'anchor': {
				this.markDirty(drag);
				const node = drag.shape.nodes[drag.index];
				const dx = point[0] - node.x;
				const dy = point[1] - node.y;
				node.x += dx;
				node.y += dy;
				node.inX += dx;
				node.inY += dy;
				node.outX += dx;
				node.outY += dy;
				this.render();
				return;
			}

			case 'in':
			case 'out': {
				this.markDirty(drag);
				const node = drag.shape.nodes[drag.index];
				const isOut = drag.mode === 'out';

				node[isOut ? 'outX' : 'inX'] = raw[0];
				node[isOut ? 'outY' : 'inY'] = raw[1];

				// 既定では反対側のハンドルを対称に保つ。Alt を押すと片側だけ動かせる
				if (!event.altKey) {
					node[isOut ? 'inX' : 'outX'] = 2 * node.x - raw[0];
					node[isOut ? 'inY' : 'outY'] = 2 * node.y - raw[1];
				}

				this.render();
				return;
			}
		}
	}

	onPointerUp(event) {
		const drag = this.drag;
		this.drag = null;

		if (!drag) return;
		if (this.refs.svg.hasPointerCapture(event.pointerId)) this.refs.svg.releasePointerCapture(event.pointerId);

		if (drag.mode === 'pan' || drag.mode === 'pen-handle') {
			this.render();
			return;
		}

		if (drag.mode === 'create') {
			if (!drag.shape) return;

			// 作成し終えたので undo 対象として確定させる
			this.shapes = this.shapes.filter((s) => s.id !== drag.shape.id);
			this.pushUndo();
			this.shapes.push(drag.shape);
			this.selectedId = drag.shape.id;
			this.tool = 'select';
			this.changed();
			return;
		}

		// 動かさずに離しただけなら形は変わっていないので、3D の作り直しまではしない
		if (drag.dirty) this.changed();
		else this.render();
	}

	/** 角ノード ↔ 曲線ノードを切り替える */
	toggleNodeSmooth(shape, index) {
		if (shape.kind !== 'path') return;

		const node = shape.nodes[index];
		if (!node) return;

		const isCorner = node.inX === node.x && node.inY === node.y && node.outX === node.x && node.outY === node.y;

		this.pushUndo();

		if (isCorner) {
			// 前後のノードを結ぶ向きに、控えめな長さのハンドルを生やす
			const prev = shape.nodes[(index - 1 + shape.nodes.length) % shape.nodes.length];
			const next = shape.nodes[(index + 1) % shape.nodes.length];
			const dx = (next.x - prev.x) / 4;
			const dy = (next.y - prev.y) / 4;

			node.outX = node.x + dx;
			node.outY = node.y + dy;
			node.inX = node.x - dx;
			node.inY = node.y - dy;
		} else {
			node.inX = node.x;
			node.inY = node.y;
			node.outX = node.x;
			node.outY = node.y;
		}

		this.changed();
	}

	bindKeyboard() {
		document.addEventListener('keydown', (event) => {
			// 入力欄での操作を邪魔しない
			if (event.target.matches('input, select, textarea')) return;
			if (!this.refs.pane.offsetParent) return;

			const meta = event.ctrlKey || event.metaKey;

			if (meta && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				this.undo();
				return;
			}

			if (meta && event.key.toLowerCase() === 'd') {
				event.preventDefault();
				this.duplicate();
				return;
			}

			if (event.key === 'Escape') {
				if (this.pen) this.finishPen(false);
				else this.setTool('select');
				return;
			}

			if (event.key === 'Enter' && this.pen) {
				this.finishPen(true);
				return;
			}

			if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId !== null) {
				event.preventDefault();
				this.remove(this.selectedId);
			}
		});
	}
}

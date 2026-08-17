/**
 * エディターの図形モデル。
 *
 * 座標は mm、Y軸は画面と同じ下向き（SVG と同じ）。押し出し時にまとめて反転する。
 * どの図形も最終的には「閉じた1本の輪郭」= 直線と3次ベジェの列に落として扱う。
 * 表示用の SVG パスも押し出し用の点列もこの輪郭から作るので、形の定義は1箇所で済む。
 */

// 円弧を3次ベジェで近似するときの制御点の比率
const KAPPA = 0.5522847498307936;

let nextId = 1;

// 新しい図形に与える既定の厚み（サイドバーの入力に追従する）
let defaultHeight = 5;

export function setDefaultHeight(mm) {
	if (Number.isFinite(mm) && mm > 0) defaultHeight = mm;
}

export function getDefaultHeight() {
	return defaultHeight;
}

export const SHAPE_LABELS = {
	rect: '矩形',
	ellipse: '楕円',
	polygon: '多角形',
	star: '星',
	path: 'パス',
	text: '文字'
};

export const OP_LABELS = {
	union: '合体',
	subtract: 'くり抜き',
	intersect: '交差',
	xor: '排他'
};

export function createShape(kind, params) {
	// z = 下端の高さ、height = 厚み。この2つで図形ごとの Z 範囲が決まる
	return { id: nextId++, kind, op: 'union', rotation: 0, z: 0, height: defaultHeight, ...params };
}

/** ドラッグで作った矩形範囲から図形を作る */
export function shapeFromDrag(kind, x0, y0, x1, y1, options = {}) {
	const x = Math.min(x0, x1);
	const y = Math.min(y0, y1);
	const w = Math.max(Math.abs(x1 - x0), 0.1);
	const h = Math.max(Math.abs(y1 - y0), 0.1);

	switch (kind) {
		case 'rect':
			return createShape('rect', { x, y, w, h, radius: 0 });

		case 'ellipse':
			return createShape('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });

		case 'polygon':
			return createShape('polygon', {
				cx: x + w / 2,
				cy: y + h / 2,
				r: Math.max(w, h) / 2,
				sides: options.sides ?? 6
			});

		case 'star':
			return createShape('star', {
				cx: x + w / 2,
				cy: y + h / 2,
				r: Math.max(w, h) / 2,
				innerRatio: options.innerRatio ?? 0.5,
				points: options.points ?? 5
			});

		default:
			return null;
	}
}

/** ペンツールのノード。ハンドルは絶対座標で持つ（等しければ角ノード）。 */
export function createNode(x, y, handleX = x, handleY = y) {
	return { x, y, inX: 2 * x - handleX, inY: 2 * y - handleY, outX: handleX, outY: handleY };
}

export function shapeCenter(shape) {
	switch (shape.kind) {
		case 'rect':
			return [shape.x + shape.w / 2, shape.y + shape.h / 2];

		case 'ellipse':
		case 'polygon':
		case 'star':
			return [shape.cx, shape.cy];

		case 'path': {
			const xs = shape.nodes.map((n) => n.x);
			const ys = shape.nodes.map((n) => n.y);
			return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
		}

		case 'text': {
			const box = shapeBounds(shape, 6);
			return box ? [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2] : [shape.x, shape.y];
		}

		default:
			return [0, 0];
	}
}

function rotate([x, y], [cx, cy], angle) {
	if (!angle) return [x, y];

	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = x - cx;
	const dy = y - cy;

	return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function line(to) {
	return { to };
}

function cubic(c1, c2, to) {
	return { c1, c2, to };
}

function ellipseContour(cx, cy, rx, ry) {
	const kx = rx * KAPPA;
	const ky = ry * KAPPA;

	return {
		start: [cx + rx, cy],
		segs: [
			cubic([cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry]),
			cubic([cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy]),
			cubic([cx - rx, cy - ky], [cx - kx, cy - ry], [cx, cy - ry]),
			cubic([cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy])
		]
	};
}

function rectContour(x, y, w, h, radius) {
	const r = Math.max(0, Math.min(radius, w / 2, h / 2));

	if (r === 0) {
		return {
			start: [x, y],
			segs: [line([x + w, y]), line([x + w, y + h]), line([x, y + h]), line([x, y])]
		};
	}

	const k = r * KAPPA;

	return {
		start: [x + r, y],
		segs: [
			line([x + w - r, y]),
			cubic([x + w - r + k, y], [x + w, y + r - k], [x + w, y + r]),
			line([x + w, y + h - r]),
			cubic([x + w, y + h - r + k], [x + w - r + k, y + h], [x + w - r, y + h]),
			line([x + r, y + h]),
			cubic([x + r - k, y + h], [x, y + h - r + k], [x, y + h - r]),
			line([x, y + r]),
			cubic([x, y + r - k], [x + r - k, y], [x + r, y])
		]
	};
}

function radialContour(cx, cy, radii) {
	const count = radii.length;
	const points = radii.map((r, i) => {
		// 真上を起点に時計回り（画面座標なので Y は下向き）
		const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
		return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
	});

	return { start: points[0], segs: [...points.slice(1), points[0]].map(line) };
}

function pathContour(nodes) {
	if (nodes.length < 2) return null;

	const segs = [];

	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const b = nodes[(i + 1) % nodes.length];
		const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y;

		segs.push(straight ? line([b.x, b.y]) : cubic([a.outX, a.outY], [b.inX, b.inY], [b.x, b.y]));
	}

	return { start: [nodes[0].x, nodes[0].y], segs };
}

/**
 * 図形を「閉じた輪郭」の配列に変換する（回転適用済み）。
 * 文字は字形ごと・穴ごとに複数の輪郭を持つため、常に配列で扱う。
 */
export function shapeToContours(shape) {
	let contours;

	switch (shape.kind) {
		case 'rect':
			contours = [rectContour(shape.x, shape.y, shape.w, shape.h, shape.radius)];
			break;

		case 'ellipse':
			contours = [ellipseContour(shape.cx, shape.cy, shape.rx, shape.ry)];
			break;

		case 'polygon':
			contours = [radialContour(shape.cx, shape.cy, Array(Math.max(3, shape.sides)).fill(shape.r))];
			break;

		case 'star': {
			const radii = [];
			for (let i = 0; i < Math.max(3, shape.points) * 2; i++) {
				radii.push(i % 2 === 0 ? shape.r : shape.r * shape.innerRatio);
			}
			contours = [radialContour(shape.cx, shape.cy, radii)];
			break;
		}

		case 'path': {
			const contour = pathContour(shape.nodes);
			contours = contour ? [contour] : [];
			break;
		}

		case 'text':
			// 輪郭は em 単位で保存してあるので、フォントサイズ倍して配置点へ移す
			contours = mapContours(shape.contours ?? [], ([x, y]) => [
				shape.x + x * shape.size,
				shape.y + y * shape.size
			]);
			break;

		default:
			contours = [];
	}

	if (contours.length === 0 || !shape.rotation) return contours;

	const center = rotationCenter(shape, contours);

	return mapContours(contours, (p) => rotate(p, center, shape.rotation));
}

function mapContours(contours, at) {
	return contours.map((contour) => ({
		start: at(contour.start),
		segs: contour.segs.map((seg) => (seg.c1 ? cubic(at(seg.c1), at(seg.c2), at(seg.to)) : line(at(seg.to))))
	}));
}

/** 回転の中心。文字は輪郭の外接矩形の中心を使う（shapeCenter の再帰を避ける） */
function rotationCenter(shape, contours) {
	if (shape.kind !== 'text') return shapeCenter(shape);

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const contour of contours) {
		for (const [x, y] of [contour.start, ...contour.segs.map((seg) => seg.to)]) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}

	return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [shape.x, shape.y];
}

/** 表示用の SVG パス文字列（曲線のまま出すのでズームしても滑らか） */
export function contourToPathData(contour) {
	if (!contour) return '';

	const n = (v) => Number(v.toFixed(4));
	let d = `M${n(contour.start[0])},${n(contour.start[1])}`;

	for (const seg of contour.segs) {
		if (seg.c1) {
			d += `C${n(seg.c1[0])},${n(seg.c1[1])} ${n(seg.c2[0])},${n(seg.c2[1])} ${n(seg.to[0])},${n(seg.to[1])}`;
		} else {
			d += `L${n(seg.to[0])},${n(seg.to[1])}`;
		}
	}

	return `${d}Z`;
}

/** 押し出し・ブーリアン用に輪郭を点列へ平坦化する */
export function contourToPoints(contour, curveSegments = 32) {
	if (!contour) return [];

	const points = [contour.start];
	let current = contour.start;

	for (const seg of contour.segs) {
		if (!seg.c1) {
			points.push(seg.to);
		} else {
			const [x0, y0] = current;
			const [x1, y1] = seg.c1;
			const [x2, y2] = seg.c2;
			const [x3, y3] = seg.to;

			for (let i = 1; i <= curveSegments; i++) {
				const t = i / curveSegments;
				const u = 1 - t;
				const a = u * u * u;
				const b = 3 * u * u * t;
				const c = 3 * u * t * t;
				const e = t * t * t;

				points.push([a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3]);
			}
		}

		current = seg.to;
	}

	// 始点と重なる終点は落とす
	const last = points[points.length - 1];
	if (points.length > 1 && Math.abs(last[0] - points[0][0]) < 1e-9 && Math.abs(last[1] - points[0][1]) < 1e-9) {
		points.pop();
	}

	return points;
}

/** 表示用の SVG パス（複数輪郭はまとめて1つの d にする） */
export function contoursToPathData(contours) {
	return contours.map(contourToPathData).join('');
}

/**
 * 押し出し・ブーリアン用の点列（輪郭ごとに1リング）。
 *
 * 字形の輪郭は短い曲線が多数つながってできているので、
 * 図形と同じ分割数を掛けると面数が跳ね上がるだけで見た目は変わらない。
 * そのため文字だけ分割を落とす。
 */
export function shapeToRings(shape, curveSegments) {
	const divisions = shape.kind === 'text' ? Math.max(2, Math.round(curveSegments / 6)) : curveSegments;

	return shapeToContours(shape)
		.map((contour) => contourToPoints(contour, divisions))
		.filter((ring) => ring.length >= 3);
}

export function shapeBounds(shape, curveSegments = 16) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const ring of shapeToRings(shape, curveSegments)) {
		for (const [x, y] of ring) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}

	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function translateShape(shape, dx, dy) {
	switch (shape.kind) {
		case 'rect':
			shape.x += dx;
			shape.y += dy;
			break;

		case 'ellipse':
		case 'polygon':
		case 'star':
			shape.cx += dx;
			shape.cy += dy;
			break;

		case 'path':
			for (const node of shape.nodes) {
				node.x += dx;
				node.y += dy;
				node.inX += dx;
				node.inY += dy;
				node.outX += dx;
				node.outY += dy;
			}
			break;

		case 'text':
			shape.x += dx;
			shape.y += dy;
			break;
	}
}

/** anchor を固定したまま factor 倍する（角ハンドルのドラッグ用） */
export function scaleShape(shape, factor, [ax, ay]) {
	const at = (x, y) => [ax + (x - ax) * factor, ay + (y - ay) * factor];

	switch (shape.kind) {
		case 'rect': {
			const [x, y] = at(shape.x, shape.y);
			shape.x = x;
			shape.y = y;
			shape.w *= factor;
			shape.h *= factor;
			shape.radius *= factor;
			break;
		}

		case 'ellipse': {
			const [cx, cy] = at(shape.cx, shape.cy);
			shape.cx = cx;
			shape.cy = cy;
			shape.rx *= factor;
			shape.ry *= factor;
			break;
		}

		case 'polygon':
		case 'star': {
			const [cx, cy] = at(shape.cx, shape.cy);
			shape.cx = cx;
			shape.cy = cy;
			shape.r *= factor;
			break;
		}

		case 'path':
			for (const node of shape.nodes) {
				[node.x, node.y] = at(node.x, node.y);
				[node.inX, node.inY] = at(node.inX, node.inY);
				[node.outX, node.outY] = at(node.outX, node.outY);
			}
			break;

		case 'text':
			// 輪郭は em 単位なので、フォントサイズを変えるだけで拡大縮小できる
			[shape.x, shape.y] = at(shape.x, shape.y);
			shape.size *= factor;
			break;
	}
}

/** プロパティパネルに出す数値項目の定義 */
export function shapeFields(shape) {
	const common = [
		{ key: 'z', label: '下端Z', unit: 'mm', step: 0.5 },
		{ key: 'height', label: '厚み', unit: 'mm', step: 0.5, min: 0.01 },
		{ key: 'rotation', label: '回転', unit: '°', step: 1, angle: true }
	];

	switch (shape.kind) {
		case 'rect':
			return [
				{ key: 'x', label: 'X', unit: 'mm', step: 1 },
				{ key: 'y', label: 'Y', unit: 'mm', step: 1 },
				{ key: 'w', label: '幅', unit: 'mm', step: 1, min: 0.1 },
				{ key: 'h', label: '高さ', unit: 'mm', step: 1, min: 0.1 },
				{ key: 'radius', label: '角丸', unit: 'mm', step: 0.5, min: 0 },
				...common
			];

		case 'ellipse':
			return [
				{ key: 'cx', label: '中心X', unit: 'mm', step: 1 },
				{ key: 'cy', label: '中心Y', unit: 'mm', step: 1 },
				{ key: 'rx', label: '半径X', unit: 'mm', step: 1, min: 0.05 },
				{ key: 'ry', label: '半径Y', unit: 'mm', step: 1, min: 0.05 },
				...common
			];

		case 'polygon':
			return [
				{ key: 'cx', label: '中心X', unit: 'mm', step: 1 },
				{ key: 'cy', label: '中心Y', unit: 'mm', step: 1 },
				{ key: 'r', label: '半径', unit: 'mm', step: 1, min: 0.05 },
				{ key: 'sides', label: '辺の数', step: 1, min: 3, max: 64, integer: true },
				...common
			];

		case 'star':
			return [
				{ key: 'cx', label: '中心X', unit: 'mm', step: 1 },
				{ key: 'cy', label: '中心Y', unit: 'mm', step: 1 },
				{ key: 'r', label: '外半径', unit: 'mm', step: 1, min: 0.05 },
				{ key: 'innerRatio', label: '内半径比', step: 0.05, min: 0.05, max: 0.95 },
				{ key: 'points', label: '頂点数', step: 1, min: 3, max: 32, integer: true },
				...common
			];

		case 'path':
			return common;

		case 'text':
			return [
				{ key: 'text', label: '文字列', type: 'text', rebake: true },
				{ key: 'size', label: 'サイズ', unit: 'mm', step: 1, min: 0.5 },
				{ key: 'x', label: 'X', unit: 'mm', step: 1 },
				{ key: 'y', label: 'Y', unit: 'mm', step: 1 },
				{ key: 'tracking', label: '字間', unit: 'em', step: 0.02, min: -0.5, max: 2, rebake: true },
				{ key: 'lineHeight', label: '行間', unit: '倍', step: 0.1, min: 0.5, max: 4, rebake: true },
				{
					key: 'align',
					label: '揃え',
					type: 'select',
					rebake: true,
					choices: [
						['left', '左'],
						['center', '中央'],
						['right', '右']
					]
				},
				...common
			];

		default:
			return [];
	}
}

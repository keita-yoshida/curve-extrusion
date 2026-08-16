import * as THREE from '../vendor/three/three.module.min.js';
import { SVGLoader } from '../vendor/three/SVGLoader.js';
import { dedupeLoop, nestLoops } from './regions.js';

// CSS の絶対単位 → mm（1in = 25.4mm, 1px = 1/96in）
const MM_PER_UNIT = {
	mm: 1,
	cm: 10,
	q: 0.25,
	in: 25.4,
	pt: 25.4 / 72,
	pc: 25.4 / 6,
	px: 25.4 / 96
};

const PX_TO_MM = MM_PER_UNIT.px;

function parseLength(value) {
	if (!value) return null;

	const match = /^\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
	if (!match) return null;

	const number = parseFloat(match[1]);
	if (!Number.isFinite(number)) return null;

	const unit = match[2].toLowerCase();
	if (unit === '%' ) return null;
	if (unit && !(unit in MM_PER_UNIT)) return null;

	return { number, unit: unit || 'px', mm: number * MM_PER_UNIT[unit || 'px'] };
}

/**
 * SVG のルート要素から「ユーザー単位1つが何mmか」を読み取る。
 * width="100mm" viewBox="0 0 100 100" なら 1ユーザー単位 = 1mm。
 * width が無い／px 指定なら CSS の 1px = 25.4/96 mm として扱う。
 */
function readSvgScale(text) {
	const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
	const root = doc.documentElement;

	if (!root || root.nodeName === 'parsererror' || root.getElementsByTagName('parsererror').length > 0) {
		return { mmPerUnit: PX_TO_MM, source: 'SVGを解析できないため 1px = 0.2646mm と仮定' };
	}

	const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
	const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;

	const width = parseLength(root.getAttribute('width'));
	const height = parseLength(root.getAttribute('height'));

	if (hasViewBox) {
		if (width) {
			return { mmPerUnit: width.mm / viewBox[2], source: `width="${root.getAttribute('width')}" と viewBox から算出` };
		}

		if (height) {
			return { mmPerUnit: height.mm / viewBox[3], source: `height="${root.getAttribute('height')}" と viewBox から算出` };
		}
	}

	return { mmPerUnit: PX_TO_MM, source: '実寸指定が無いため 1px = 0.2646mm と仮定' };
}

/**
 * サブパスを 'closed' / 'open' / 'empty' に分類する。
 * 'empty' は moveto だけのサブパス（`M x y m dx dy ...` の書き方で発生する）で、
 * 警告の対象にはしない。
 */
function classifySubPath(subPath) {
	const points = subPath.getPoints();
	if (points.length < 3) return 'empty';

	if (subPath.autoClose) return 'closed';

	const box = new THREE.Box2().setFromPoints(points);
	const size = box.getSize(new THREE.Vector2());
	const eps = Math.max(size.x, size.y) * 1e-4 + 1e-9;

	return points[0].distanceTo(points[points.length - 1]) <= eps ? 'closed' : 'open';
}

/**
 * SVG テキストをリージョン群へ変換する。
 *
 * holeMode:
 *   'path' … 穴の判定を <path> 要素ごとに行う（fill-rule に忠実。SVG の仕様どおり）
 *   'global' … 閉ループを全て集めてから包含関係で判定する（別々の要素で描かれた穴も抜ける）
 */
export function svgToRegions(text, { curveSegments = 32, holeMode = 'path' } = {}) {
	const loader = new SVGLoader();
	loader.defaultDPI = 96;

	const data = loader.parse(text);
	const warnings = [];

	let closedCount = 0;
	let openCount = 0;

	if (holeMode === 'global') {
		const loops = [];

		for (const path of data.paths) {
			for (const subPath of path.subPaths) {
				const kind = classifySubPath(subPath);

				if (kind === 'open') openCount++;
				if (kind !== 'closed') continue;

				closedCount++;
				loops.push(dedupeLoop(subPath.getPoints(curveSegments)));
			}
		}

		if (openCount > 0) warnings.push(`閉じていないパスを ${openCount} 本スキップしました。`);

		return { regions: nestLoops(loops), closedCount, openCount, warnings, scale: readSvgScale(text) };
	}

	const regions = [];

	for (const path of data.paths) {
		const kinds = path.subPaths.map(classifySubPath);
		const closed = path.subPaths.filter((_, i) => kinds[i] === 'closed');

		closedCount += closed.length;
		openCount += kinds.filter((kind) => kind === 'open').length;

		if (closed.length === 0) continue;

		// 閉じたサブパスだけを持つ ShapePath を組み直して fill-rule 判定にかける
		const shapePath = new THREE.ShapePath();
		shapePath.userData = path.userData || {};
		shapePath.subPaths = closed;

		for (const shape of shapePath.toShapes()) {
			const points = shape.extractPoints(curveSegments);

			regions.push({
				contour: dedupeLoop(points.shape),
				holes: points.holes.map(dedupeLoop).filter((hole) => hole.length >= 3)
			});
		}
	}

	if (openCount > 0) warnings.push(`閉じていないパスを ${openCount} 本スキップしました。`);

	return {
		regions: regions.filter((r) => r.contour.length >= 3),
		closedCount,
		openCount,
		warnings,
		scale: readSvgScale(text)
	};
}

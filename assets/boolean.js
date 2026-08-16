import { shapeToPoints } from './editor-shapes.js';

/**
 * パスファインダー（ブーリアン演算）。
 *
 * 図形はベジェのまま非破壊で保持し、ここで初めて平坦化してから polygon-clipping にかける。
 * 押し出しのためにどのみち平坦化するので、余分なコストは発生しない。
 */

const OPS = {
	union: (a, b) => self.polygonClipping.union(a, b),
	subtract: (a, b) => self.polygonClipping.difference(a, b),
	intersect: (a, b) => self.polygonClipping.intersection(a, b),
	xor: (a, b) => self.polygonClipping.xor(a, b)
};

/** 図形1つを polygon-clipping の MultiPolygon（[[外周, 穴...], ...]）にする */
function shapeToMultiPolygon(shape, curveSegments) {
	const points = shapeToPoints(shape, curveSegments);
	if (points.length < 3) return [];

	// polygon-clipping はリングが閉じている（先頭==末尾）ことを前提にする
	return [[[...points, points[0]]]];
}

/**
 * 図形リストを下から順に畳み込んで最終形状を得る。
 * 最初の図形は演算子によらず土台として扱う（空集合から引いても何も残らないため）。
 */
export function shapesToMultiPolygon(shapes, curveSegments) {
	let result = [];

	for (const shape of shapes) {
		if (shape.hidden) continue;

		const operand = shapeToMultiPolygon(shape, curveSegments);
		if (operand.length === 0) continue;

		if (result.length === 0) {
			result = shape.op === 'subtract' || shape.op === 'intersect' ? [] : operand;
			continue;
		}

		result = (OPS[shape.op] ?? OPS.union)(result, operand);
	}

	return result;
}

/** MultiPolygon を押し出しパイプラインのリージョン形式へ変換する */
export function multiPolygonToRegions(multiPolygon) {
	const toPoints = (ring) => {
		const points = ring.map(([x, y]) => ({ x, y }));

		// 閉じたリングの末尾は始点と重なるので落とす
		const last = points[points.length - 1];
		if (points.length > 1 && last.x === points[0].x && last.y === points[0].y) points.pop();

		return points;
	};

	const regions = [];

	for (const polygon of multiPolygon) {
		const contour = toPoints(polygon[0] ?? []);
		if (contour.length < 3) continue;

		regions.push({
			contour,
			holes: polygon.slice(1).map(toPoints).filter((hole) => hole.length >= 3)
		});
	}

	return regions;
}

/** 図形リスト → 押し出し可能なリージョン群 */
export function shapesToRegions(shapes, curveSegments) {
	return multiPolygonToRegions(shapesToMultiPolygon(shapes, curveSegments));
}

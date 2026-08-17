import { shapeToRings } from './editor-shapes.js';
import { nestLoops } from './regions.js';

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

// polygon-clipping はリングが閉じている（先頭 == 末尾）ことを前提にする
function closeRing(points) {
	const ring = points.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
	ring.push([...ring[0]]);
	return ring;
}

/** 図形1つを polygon-clipping の MultiPolygon（[[外周, 穴...], ...]）にする */
function shapeToMultiPolygon(shape, curveSegments) {
	const rings = shapeToRings(shape, curveSegments);
	if (rings.length === 0) return [];

	if (rings.length === 1) return [[closeRing(rings[0])]];

	// 文字は字形ごと・穴ごとに輪郭を持つので、まず内外を判定して穴に振り分ける。
	// そのうえで union をかけ、字形どうしが重なっている場合も1つに解消する。
	const regions = nestLoops(rings.map((ring) => ring.map(([x, y]) => ({ x, y }))));
	if (regions.length === 0) return [];

	const multiPolygon = regions.map((region) => [closeRing(region.contour), ...region.holes.map(closeRing)]);

	return self.polygonClipping.union(multiPolygon);
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

export function regionsToMultiPolygon(regions) {
	return regions.map((region) => [closeRing(region.contour), ...region.holes.map(closeRing)]);
}

/**
 * リージョンどうしの差集合。
 * Z の帯を積むとき、隣の帯と接している面には蓋をしない（＝差分にだけ蓋をする）ために使う。
 */
export function differenceRegions(regions, subtract) {
	if (regions.length === 0) return [];
	if (!subtract || subtract.length === 0) return regions;

	return multiPolygonToRegions(
		self.polygonClipping.difference(regionsToMultiPolygon(regions), regionsToMultiPolygon(subtract))
	);
}

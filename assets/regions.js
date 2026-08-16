import * as THREE from 'three';

/**
 * 「リージョン」= 1つの外周(contour)と0個以上の穴(holes)からなる閉じた領域。
 * 点列は Vector2 の配列で、終点に始点を重複させない形に正規化しておく。
 * SVG / DXF どちらの入力もこの形に落としてから押し出す。
 */

/** 終点が始点と重なっていれば取り除く（面積0の辺を作らないため） */
export function dedupeLoop(points) {
	const out = points.map((p) => new THREE.Vector2(p.x, p.y));

	while (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) < 1e-20) {
		out.pop();
	}

	return out;
}

function pointInPolygon(p, polygon) {
	let inside = false;

	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];

		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}

	return inside;
}

/** 多角形の「確実に内側」の点を1つ返す（入れ子判定用） */
function interiorPoint(polygon, box) {
	const point = box.getCenter(new THREE.Vector2());

	if (pointInPolygon(point, polygon)) return point;

	// 中心が外側（凹形状など）の場合は水平レイの交点2つの中点を使う
	const y = point.y;
	const intercepts = [];

	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];

		if (a.y > y !== b.y > y) {
			intercepts.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
		}
	}

	if (intercepts.length > 1) {
		intercepts.sort((m, n) => m - n);
		point.x = (intercepts[0] + intercepts[1]) / 2;
	}

	return point;
}

/**
 * 閉ループ群を包含関係で入れ子にしてリージョンへ変換する。
 * 入れ子の深さが偶数なら外周、奇数なら穴（even-odd）。
 */
export function nestLoops(loops) {
	const entries = [];

	for (const loop of loops) {
		const points = dedupeLoop(loop);
		if (points.length < 3) continue;

		const absArea = Math.abs(THREE.ShapeUtils.area(points));
		if (absArea <= 1e-12) continue;

		const box = new THREE.Box2().setFromPoints(points);
		entries.push({ points, absArea, box, interior: interiorPoint(points, box), depth: 0, parent: null });
	}

	// 面積の大きい順に並べると、自分を含みうるループは必ず先に処理済みになる
	entries.sort((a, b) => b.absArea - a.absArea);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];

		// 面積が近いものから遡ることで、最も内側の親が最初に見つかる
		for (let j = i - 1; j >= 0; j--) {
			const candidate = entries[j];

			if (!candidate.box.containsBox(entry.box)) continue;
			if (!pointInPolygon(entry.interior, candidate.points)) continue;

			entry.parent = candidate;
			entry.depth = candidate.depth + 1;
			break;
		}
	}

	const regions = new Map();

	for (const entry of entries) {
		if (entry.depth % 2 === 0) regions.set(entry, { contour: entry.points, holes: [] });
	}

	for (const entry of entries) {
		if (entry.depth % 2 === 1 && regions.has(entry.parent)) {
			regions.get(entry.parent).holes.push(entry.points);
		}
	}

	return [...regions.values()];
}

export function regionsBoundingBox(regions) {
	const box = new THREE.Box2();

	for (const region of regions) {
		for (const p of region.contour) box.expandByPoint(p);
	}

	return box;
}

/**
 * リージョンに拡大縮小・Y反転・平行移動を適用する。
 * SVG は Y軸が下向きなので flipY で反転させる。
 */
export function transformRegions(regions, { scale = 1, flipY = false, offsetX = 0, offsetY = 0 } = {}) {
	const sy = flipY ? -scale : scale;
	const map = (points) => points.map((p) => new THREE.Vector2(p.x * scale + offsetX, p.y * sy + offsetY));

	return regions.map((region) => ({
		contour: map(region.contour),
		holes: region.holes.map(map)
	}));
}

function regionsToShapes(regions) {
	return regions.map((region) => {
		const shape = new THREE.Shape(region.contour);
		shape.holes = region.holes.map((hole) => new THREE.Path(hole));
		return shape;
	});
}

/**
 * リージョンを厚み thickness で押し出して1つのジオメトリにまとめる。
 * ExtrudeGeometry は Shape の配列をそのまま結合してくれる。
 */
export function extrudeRegions(regions, { thickness, centerOrigin = true } = {}) {
	const shapes = regionsToShapes(regions);
	if (shapes.length === 0) return null;

	const geometry = new THREE.ExtrudeGeometry(shapes, {
		depth: thickness,
		bevelEnabled: false,
		steps: 1
	});

	if (centerOrigin) {
		geometry.computeBoundingBox();
		const box = geometry.boundingBox;
		geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, 0);
	}

	geometry.computeVertexNormals();
	geometry.computeBoundingBox();

	return geometry;
}

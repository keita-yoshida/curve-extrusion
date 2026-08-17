import * as THREE from '../vendor/three/three.module.min.js';
import { differenceRegions, multiPolygonToRegions, shapesToMultiPolygon } from './boolean.js';

/**
 * 図形ごとの Z 範囲から「帯」を作り、積み上げて1つのソリッドにする。
 *
 * Z の境目で全体を薄い帯に切り、帯ごとに既存の 2D ブーリアンを畳む。
 * こうすると 3D の CSG を持ち込まずに、浮き出し・彫り込み・貫通が同じ仕組みで書ける。
 */

const EPS = 1e-6;

export function shapeTop(shape) {
	return shape.z + shape.height;
}

/**
 * Z の境目で帯に分け、それぞれの断面を求める。
 * ある帯に「まるごと入っている」図形だけがその帯の演算に参加する。
 */
export function shapesToBands(shapes, curveSegments) {
	const visible = shapes.filter((shape) => !shape.hidden && shape.height > EPS);
	if (visible.length === 0) return [];

	const levels = [...new Set(visible.flatMap((shape) => [shape.z, shapeTop(shape)]))].sort((a, b) => a - b);
	const bands = [];

	for (let i = 0; i < levels.length - 1; i++) {
		const z0 = levels[i];
		const z1 = levels[i + 1];
		if (z1 - z0 <= EPS) continue;

		// 重ね順は元のリストのままなので、演算子の意味は今までと変わらない
		const active = visible.filter((shape) => shape.z <= z0 + EPS && shapeTop(shape) >= z1 - EPS);
		if (active.length === 0) continue;

		const regions = multiPolygonToRegions(shapesToMultiPolygon(active, curveSegments));
		if (regions.length === 0) continue;

		bands.push({ z0, z1, regions });
	}

	return bands;
}

const pointKey = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;

/** 点 p が線分 ab の内側（端点を除く）に載っているか */
function onSegment(a, b, p) {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lengthSq = abx * abx + aby * aby;
	if (lengthSq <= EPS * EPS) return false;

	const apx = p.x - a.x;
	const apy = p.y - a.y;

	// 線分から離れていれば対象外
	if (Math.abs(abx * apy - aby * apx) / Math.sqrt(lengthSq) > 1e-7) return false;

	const t = (apx * abx + apy * aby) / lengthSq;

	return t > 1e-9 && t < 1 - 1e-9;
}

/**
 * 蓋の境界が壁の途中に接する（T字接合）と、そこだけ面が合わずに隙間ができる。
 * ブーリアンの計算結果は共線の頂点を残したり落としたりするので、同じ場所でも
 * 辺の分かれ方が食い違うことがある。
 *
 * そこで全体の頂点を1つの格子に入れ、各辺の途中に載る頂点をすべて挿入して揃える。
 * 「そのリングが既に持っている頂点」も除外できない（別の場所の頂点が、
 * 長い辺の途中に載っていることがある）ため、格子で当たりを絞って総当たりを避ける。
 */
function collectPoints(regionsList) {
	const points = new Map();

	for (const regions of regionsList) {
		for (const region of regions) {
			for (const ring of [region.contour, ...region.holes]) {
				for (const point of ring) points.set(pointKey(point), point);
			}
		}
	}

	return points;
}

const MAX_CELLS_PER_EDGE = 4096;

function buildIndex(points) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}

	const cell = Math.max(Math.max(maxX - minX, maxY - minY) / 128, 1e-3);
	const grid = new Map();

	for (const point of points) {
		const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
		if (!grid.has(key)) grid.set(key, []);
		grid.get(key).push(point);
	}

	return { grid, cell, points };
}

function pointsNear(index, a, b) {
	const { grid, cell } = index;
	const x0 = Math.floor(Math.min(a.x, b.x) / cell);
	const x1 = Math.floor(Math.max(a.x, b.x) / cell);
	const y0 = Math.floor(Math.min(a.y, b.y) / cell);
	const y1 = Math.floor(Math.max(a.y, b.y) / cell);

	// 極端に長い辺は格子を舐めるより総当たりのほうが速い
	if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_EDGE) return index.points;

	const found = [];

	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) {
			const bucket = grid.get(`${x},${y}`);
			if (bucket) found.push(...bucket);
		}
	}

	return found;
}

function splitRing(ring, index) {
	const out = [];

	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];

		out.push(a);

		const between = [];
		const seen = new Set();

		for (const point of pointsNear(index, a, b)) {
			const key = pointKey(point);
			if (seen.has(key) || !onSegment(a, b, point)) continue;

			seen.add(key);
			between.push(point);
		}

		if (between.length > 0) {
			between.sort((p, q) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2 - ((q.x - a.x) ** 2 + (q.y - a.y) ** 2));
			out.push(...between);
		}
	}

	return out;
}

function splitRegionsWith(regions, index) {
	return regions.map((region) => ({
		contour: splitRing(region.contour, index),
		holes: region.holes.map((hole) => splitRing(hole, index))
	}));
}

/** 外周は時計回り、穴は反時計回りに揃える（Three.js の押し出しと同じ規約） */
function orient(points, clockwise) {
	const ring = points.map((p) => new THREE.Vector2(p.x, p.y));

	return THREE.ShapeUtils.isClockWise(ring) === clockwise ? ring : ring.reverse();
}

function normalizeRegion(region) {
	return { contour: orient(region.contour, true), holes: region.holes.map((hole) => orient(hole, false)) };
}

function addWalls(out, regions, z0, z1) {
	for (const region of regions) {
		const { contour, holes } = normalizeRegion(region);

		for (const ring of [contour, ...holes]) {
			// 稜線の向きは Three.js の sidewalls と同じく、添字を1つ戻る向きに取る
			for (let j = ring.length - 1; j >= 0; j--) {
				const k = j === 0 ? ring.length - 1 : j - 1;
				const a = ring[j];
				const b = ring[k];

				out.push(a.x, a.y, z0, b.x, b.y, z0, a.x, a.y, z1);
				out.push(b.x, b.y, z0, b.x, b.y, z1, a.x, a.y, z1);
			}
		}
	}
}

const edgeKey = (p, q) => {
	const a = pointKey(p);
	const b = pointKey(q);
	return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/** 三角形分割の境界が、元のリングの辺とちょうど一致しているか */
function isConsistent(faces, vertices, ringEdges) {
	const counts = new Map();

	for (const face of faces) {
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(vertices[face[e]], vertices[face[(e + 1) % 3]]);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}

	let boundary = 0;

	for (const [key, count] of counts) {
		if (count !== 1) continue;
		if (!ringEdges.has(key)) return false;
		boundary++;
	}

	return boundary === ringEdges.size;
}

function rotated(points, angle) {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	return points.map((p) => new THREE.Vector2(p.x * cos - p.y * sin, p.x * sin + p.y * cos));
}

/**
 * 穴つき多角形の三角形分割。
 *
 * 同じ直線上に穴の頂点が並ぶと earcut が破綻し、リングと食い違う境界を返すことがある
 * （例: 「曲」のように囲みが横一列に並ぶ字）。そのときは座標をわずかに回して
 * 分割をやり直す。使うのは添字だけなので、出力の座標は元のまま変わらない。
 */
function triangulateRegion(contour, holes) {
	const vertices = [contour, ...holes].flat();
	const ringEdges = new Set();

	for (const ring of [contour, ...holes]) {
		for (let i = 0; i < ring.length; i++) ringEdges.add(edgeKey(ring[i], ring[(i + 1) % ring.length]));
	}

	let faces = THREE.ShapeUtils.triangulateShape(contour, holes);
	if (isConsistent(faces, vertices, ringEdges)) return faces;

	for (const angle of [0.013, 0.117, 0.396, 0.751]) {
		const candidate = THREE.ShapeUtils.triangulateShape(
			rotated(contour, angle),
			holes.map((hole) => rotated(hole, angle))
		);

		if (isConsistent(candidate, vertices, ringEdges)) return candidate;
	}

	return faces;
}

function addCap(out, regions, z, facingUp) {
	for (const region of regions) {
		const { contour, holes } = normalizeRegion(region);
		const vertices = [contour, ...holes].flat();
		const faces = triangulateRegion(contour, holes);

		for (const face of faces) {
			const [a, b, c] = facingUp ? face : [face[2], face[1], face[0]];

			for (const index of [a, b, c]) {
				const point = vertices[index];
				out.push(point.x, point.y, z);
			}
		}
	}
}

/**
 * 帯を積み上げてジオメトリにする。
 *
 * 隣の帯と接している面には蓋をせず、はみ出した差分だけに蓋をする。
 * こうすると内部に余計な面が残らず、積んでも全体が1枚の閉じた面になる。
 */
export function extrudeBands(bands, { centerOrigin = true } = {}) {
	if (bands.length === 0) return null;

	const positions = [];

	// 先に全部の蓋を求めてから、モデル全体の頂点で1つの格子を作る。
	// 帯をまたいで接する面どうしも、これで頂点が揃う。
	const caps = bands.map((band, index) => {
		const previous = bands[index - 1];
		const next = bands[index + 1];

		return {
			top: differenceRegions(band.regions, next && Math.abs(next.z0 - band.z1) <= EPS ? next.regions : null),
			bottom: differenceRegions(band.regions, previous && Math.abs(previous.z1 - band.z0) <= EPS ? previous.regions : null)
		};
	});

	const index = buildIndex([
		...collectPoints([...bands.map((band) => band.regions), ...caps.map((c) => c.top), ...caps.map((c) => c.bottom)]).values()
	]);

	bands.forEach((band, i) => {
		addWalls(positions, splitRegionsWith(band.regions, index), band.z0, band.z1);
		addCap(positions, splitRegionsWith(caps[i].top, index), band.z1, true);
		addCap(positions, splitRegionsWith(caps[i].bottom, index), band.z0, false);
	});

	if (positions.length === 0) return null;

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

	if (centerOrigin) {
		geometry.computeBoundingBox();
		const box = geometry.boundingBox;
		geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, 0);
	}

	geometry.computeVertexNormals();
	geometry.computeBoundingBox();

	return geometry;
}

/**
 * Z 範囲を持たない単純な押し出し（SVG/DXF の読み込み用）。
 * 帯が1枚だけの積み上げとして扱い、生成器を1つに揃える。
 */
export function extrudeRegions(regions, { thickness, centerOrigin = true } = {}) {
	if (regions.length === 0 || !(thickness > 0)) return null;

	return extrudeBands([{ z0: 0, z1: thickness, regions }], { centerOrigin });
}

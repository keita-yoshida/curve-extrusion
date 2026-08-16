import * as THREE from 'three';
import { nestLoops } from './regions.js';

const TAU = Math.PI * 2;

// $INSUNITS → mm 係数（実用的な単位のみ。0 = 単位なしは mm 扱い）
const INSUNITS_MM = {
	1: 25.4, // inches
	2: 304.8, // feet
	4: 1, // mm
	5: 10, // cm
	6: 1000, // m
	8: 0.0000254, // microinches
	9: 0.0254, // mils
	10: 914.4, // yards
	13: 0.001, // microns
	14: 100, // decimeters
	15: 10000 // decameters
};

const INSUNITS_LABEL = {
	1: 'inch',
	2: 'feet',
	4: 'mm',
	5: 'cm',
	6: 'm',
	8: 'microinch',
	9: 'mil',
	10: 'yard',
	13: 'micron',
	14: 'dm',
	15: 'dam'
};

/** $INSUNITS から「図面単位1つが何mmか」を読み取る */
export function readDxfScale(dxf) {
	const code = dxf?.header?.$INSUNITS;

	if (code in INSUNITS_MM) {
		return { mmPerUnit: INSUNITS_MM[code], source: `$INSUNITS = ${INSUNITS_LABEL[code]}` };
	}

	return { mmPerUnit: 1, source: '単位指定が無いため 1図面単位 = 1mm と仮定' };
}

function v2(x, y) {
	return new THREE.Vector2(x, y);
}

/** 円弧上の点を吐き出す。includeStart=false のときは始点を含めない。 */
function pushArc(out, cx, cy, rx, ry, rotation, startAngle, sweep, curveSegments, includeStart) {
	const steps = Math.max(2, Math.ceil((curveSegments * Math.abs(sweep)) / TAU));
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);

	for (let i = includeStart ? 0 : 1; i <= steps; i++) {
		const a = startAngle + (sweep * i) / steps;
		const x = rx * Math.cos(a);
		const y = ry * Math.sin(a);

		out.push(v2(cx + x * cos - y * sin, cy + x * sin + y * cos));
	}
}

/** ポリラインの bulge（膨らみ）を円弧に展開する。bulge = tan(中心角/4)。 */
function pushBulge(out, p0, p1, bulge, curveSegments) {
	const theta = 4 * Math.atan(bulge);
	const dx = p1.x - p0.x;
	const dy = p1.y - p0.y;
	const chord = Math.hypot(dx, dy);

	if (chord < 1e-12 || Math.abs(theta) < 1e-9) {
		out.push(v2(p1.x, p1.y));
		return;
	}

	const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
	// 弦の中点から中心までの距離。中心角が180°を超えると符号が反転する
	const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2)) * (Math.abs(theta) > Math.PI ? -1 : 1);
	const sign = bulge > 0 ? 1 : -1;
	const cx = (p0.x + p1.x) / 2 - (sign * h * dy) / chord;
	const cy = (p0.y + p1.y) / 2 + (sign * h * dx) / chord;

	const a0 = Math.atan2(p0.y - cy, p0.x - cx);
	const a1 = Math.atan2(p1.y - cy, p1.x - cx);

	let sweep = a1 - a0;
	if (bulge > 0) while (sweep <= 0) sweep += TAU;
	else while (sweep >= 0) sweep -= TAU;

	pushArc(out, cx, cy, radius, radius, 0, a0, sweep, curveSegments, false);
}

/** de Boor 法による B-スプライン評価（重みは無視した近似） */
function bsplineAt(t, degree, points, knots) {
	const domainStart = degree;
	const domainEnd = knots.length - 1 - degree;
	const low = knots[domainStart];
	const high = knots[domainEnd];

	let u = Math.min(high, Math.max(low, t * (high - low) + low));

	let span = domainStart;
	while (span < domainEnd - 1 && u >= knots[span + 1]) span++;

	const v = points.map((p) => [p.x, p.y]);

	for (let l = 1; l <= degree + 1; l++) {
		for (let i = span; i > span - degree - 1 + l; i--) {
			const denom = knots[i + degree + 1 - l] - knots[i];
			const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;

			v[i][0] = (1 - alpha) * v[i - 1][0] + alpha * v[i][0];
			v[i][1] = (1 - alpha) * v[i - 1][1] + alpha * v[i][1];
		}
	}

	return v2(v[span][0], v[span][1]);
}

function splineToPoints(entity, curveSegments) {
	const degree = entity.degreeOfSplineCurve || 3;
	const control = entity.controlPoints;
	const knots = entity.knotValues;

	if (control && control.length > degree && knots && knots.length === control.length + degree + 1) {
		const spans = Math.max(1, control.length - degree);
		const samples = Math.min(2000, Math.max(16, curveSegments * spans));
		const out = [];

		for (let i = 0; i <= samples; i++) out.push(bsplineAt(i / samples, degree, control, knots));

		return out;
	}

	// ノットが揃っていない場合はフィット点／制御点を通る曲線で近似する
	const fallback = entity.fitPoints?.length > 1 ? entity.fitPoints : control;
	if (!fallback || fallback.length < 2) return [];

	if (fallback.length === 2) return fallback.map((p) => v2(p.x, p.y));

	const curve = new THREE.SplineCurve(fallback.map((p) => v2(p.x, p.y)));

	return curve.getPoints(Math.min(2000, Math.max(16, curveSegments * fallback.length)));
}

/** DXF エンティティ1つを折れ線（{ points, closed }）へ展開する */
function entityToPolyline(entity, curveSegments) {
	switch (entity.type) {
		case 'LINE': {
			const vertices = entity.vertices || [];
			if (vertices.length < 2) return null;

			return { points: vertices.map((p) => v2(p.x, p.y)), closed: false };
		}

		case 'LWPOLYLINE':
		case 'POLYLINE': {
			const vertices = entity.vertices || [];
			if (vertices.length < 2) return null;

			const closed = Boolean(entity.shape);
			const points = [v2(vertices[0].x, vertices[0].y)];
			const last = closed ? vertices.length : vertices.length - 1;

			for (let i = 0; i < last; i++) {
				const a = vertices[i];
				const b = vertices[(i + 1) % vertices.length];
				const bulge = a.bulge || 0;

				if (bulge) pushBulge(points, a, b, bulge, curveSegments);
				else points.push(v2(b.x, b.y));
			}

			return { points, closed };
		}

		case 'CIRCLE': {
			if (!entity.center || !(entity.radius > 0)) return null;

			const points = [];
			pushArc(points, entity.center.x, entity.center.y, entity.radius, entity.radius, 0, 0, TAU, curveSegments, true);
			points.pop(); // 終点は始点と同じなので落とす

			return { points, closed: true };
		}

		case 'ARC': {
			if (!entity.center || !(entity.radius > 0)) return null;

			let sweep = (entity.endAngle || 0) - (entity.startAngle || 0);
			while (sweep <= 0) sweep += TAU;

			const points = [];
			pushArc(points, entity.center.x, entity.center.y, entity.radius, entity.radius, 0, entity.startAngle || 0, sweep, curveSegments, true);

			return { points, closed: false };
		}

		case 'ELLIPSE': {
			const major = entity.majorAxisEndPoint;
			if (!entity.center || !major) return null;

			const rx = Math.hypot(major.x, major.y);
			const ry = rx * (entity.axisRatio ?? 1);
			if (!(rx > 0)) return null;

			const rotation = Math.atan2(major.y, major.x);
			const start = entity.startAngle ?? 0;
			const end = entity.endAngle ?? TAU;

			let sweep = end - start;
			while (sweep <= 1e-9) sweep += TAU;

			const full = Math.abs(sweep - TAU) < 1e-6;
			const points = [];
			pushArc(points, entity.center.x, entity.center.y, rx, ry, rotation, start, sweep, curveSegments, true);
			if (full) points.pop();

			return { points, closed: full };
		}

		case 'SPLINE': {
			const points = splineToPoints(entity, curveSegments);
			if (points.length < 2) return null;

			return { points, closed: Boolean(entity.closed) };
		}

		default:
			return null;
	}
}

/** INSERT を展開しつつ、全エンティティを平坦な配列にする */
function flattenEntities(entities, blocks, transform, depth, out) {
	if (depth > 8) return;

	for (const entity of entities || []) {
		if (entity.type !== 'INSERT') {
			out.push({ entity, transform });
			continue;
		}

		const block = blocks?.[entity.name];
		if (!block?.entities) continue;

		const base = block.position || { x: 0, y: 0 };
		const rotation = ((entity.rotation || 0) * Math.PI) / 180;
		const sx = entity.xScale ?? 1;
		const sy = entity.yScale ?? 1;
		const columns = Math.max(1, entity.columnCount || 1);
		const rows = Math.max(1, entity.rowCount || 1);

		for (let c = 0; c < columns; c++) {
			for (let r = 0; r < rows; r++) {
				const offsetX = c * (entity.columnSpacing || 0);
				const offsetY = r * (entity.rowSpacing || 0);

				const local = (p) => {
					// ブロック基点を原点に寄せ → 拡大縮小 → 回転 → 配置位置へ
					const x = (p.x - base.x) * sx;
					const y = (p.y - base.y) * sy;
					const rx = x * Math.cos(rotation) - y * Math.sin(rotation);
					const ry = x * Math.sin(rotation) + y * Math.cos(rotation);

					return transform({
						x: rx + (entity.position?.x || 0) + offsetX,
						y: ry + (entity.position?.y || 0) + offsetY
					});
				};

				flattenEntities(block.entities, blocks, local, depth + 1, out);
			}
		}
	}
}

function quantize(point, tolerance) {
	return `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)}`;
}

/**
 * 開いた折れ線どうしを端点でつなぎ、閉ループを作る。
 * CAD 由来の DXF は線分がバラバラに並んでいることが多いため必須の処理。
 */
function stitchLoops(open, tolerance) {
	const loops = [];
	const used = new Array(open.length).fill(false);
	const index = new Map();

	const register = (key, value) => {
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(value);
	};

	open.forEach((poly, i) => {
		register(quantize(poly.points[0], tolerance), { i, end: 0 });
		register(quantize(poly.points[poly.points.length - 1], tolerance), { i, end: 1 });
	});

	const endpointOf = (candidate) => {
		const points = open[candidate.i].points;
		return candidate.end === 0 ? points[0] : points[points.length - 1];
	};

	// 量子化セルの境界をまたぐ端点も拾えるよう、周囲3x3セルを走査する
	const findNext = (point) => {
		const cx = Math.round(point.x / tolerance);
		const cy = Math.round(point.y / tolerance);

		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const candidate of index.get(`${cx + dx},${cy + dy}`) || []) {
					if (used[candidate.i]) continue;
					if (point.distanceTo(endpointOf(candidate)) > tolerance) continue;

					return candidate;
				}
			}
		}

		return null;
	};

	let dangling = 0;

	for (let start = 0; start < open.length; start++) {
		if (used[start]) continue;

		used[start] = true;

		const chain = [...open[start].points];
		const first = chain[0];
		let tail = chain[chain.length - 1];
		let closed = false;

		while (true) {
			if (tail.distanceTo(first) <= tolerance) {
				closed = true;
				break;
			}

			const next = findNext(tail);
			if (!next) break;

			used[next.i] = true;

			const points = next.end === 0 ? open[next.i].points : [...open[next.i].points].reverse();
			for (let i = 1; i < points.length; i++) chain.push(points[i]);

			tail = chain[chain.length - 1];
		}

		if (closed) loops.push(chain);
		else dangling += 1;
	}

	return { loops, dangling };
}

/**
 * DXF テキストをリージョン群へ変換する。
 * DXF は Y軸が上向きなので SVG のような反転は不要。
 */
export function dxfToRegions(text, { curveSegments = 32 } = {}) {
	const parser = new self.DxfParser();
	const dxf = parser.parseSync(text);

	if (!dxf) throw new Error('DXFを解析できませんでした。');

	const flat = [];
	flattenEntities(dxf.entities, dxf.blocks, (p) => p, 0, flat);

	const closedLoops = [];
	const openPolylines = [];
	const box = new THREE.Box2();

	for (const { entity, transform } of flat) {
		const polyline = entityToPolyline(entity, curveSegments);
		if (!polyline) continue;

		const points = polyline.points.map((p) => {
			const t = transform(p);
			const point = v2(t.x, t.y);
			box.expandByPoint(point);
			return point;
		});

		if (points.length < 2) continue;

		if (polyline.closed) closedLoops.push(points);
		else openPolylines.push({ points });
	}

	const warnings = [];

	if (closedLoops.length === 0 && openPolylines.length === 0) {
		return { regions: [], closedCount: 0, openCount: 0, warnings: ['押し出せる図形要素が見つかりませんでした。'] };
	}

	const size = box.getSize(new THREE.Vector2());
	const tolerance = Math.max(Math.max(size.x, size.y) * 1e-5, 1e-9);
	const { loops: stitched, dangling } = stitchLoops(openPolylines, tolerance);

	if (dangling > 0) warnings.push(`閉じられなかった線を ${dangling} 本スキップしました。`);

	const loops = [...closedLoops, ...stitched];

	return {
		regions: nestLoops(loops),
		closedCount: loops.length,
		openCount: dangling,
		scale: readDxfScale(dxf),
		warnings
	};
}

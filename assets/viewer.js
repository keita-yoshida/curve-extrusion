import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

/** Three.js のシーン・カメラ・操作をまとめた3Dプレビュー */
export class Viewer {
	constructor(canvas) {
		this.canvas = canvas;

		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

		this.scene = new THREE.Scene();

		this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
		this.camera.position.set(0, -80, 60);
		this.camera.up.set(0, 0, 1);

		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.12;

		this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));

		this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
		this.keyLight.position.set(1, -1.4, 2);
		this.scene.add(this.keyLight);

		this.fillLight = new THREE.DirectionalLight(0xffffff, 1.0);
		this.fillLight.position.set(-1.5, 1, 0.6);
		this.scene.add(this.fillLight);

		this.grid = new THREE.GridHelper(100, 10, 0x8899aa, 0x33404d);
		this.grid.rotation.x = Math.PI / 2;
		this.scene.add(this.grid);

		this.material = new THREE.MeshStandardMaterial({
			color: 0x6aa9ff,
			metalness: 0.05,
			roughness: 0.55,
			flatShading: true,
			side: THREE.DoubleSide
		});

		this.mesh = null;
		this.edges = null;

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(canvas.parentElement);

		this.resize();
		this.renderer.setAnimationLoop(() => {
			this.controls.update();
			this.renderer.render(this.scene, this.camera);
		});
	}

	resize() {
		const parent = this.canvas.parentElement;
		const width = Math.max(1, parent.clientWidth);
		const height = Math.max(1, parent.clientHeight);

		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
	}

	clear() {
		if (this.mesh) {
			this.scene.remove(this.mesh);
			this.mesh.geometry.dispose();
			this.mesh = null;
		}

		if (this.edges) {
			this.scene.remove(this.edges);
			this.edges.geometry.dispose();
			this.edges.material.dispose();
			this.edges = null;
		}
	}

	setGeometry(geometry) {
		this.clear();

		this.mesh = new THREE.Mesh(geometry, this.material);
		this.scene.add(this.mesh);

		this.edges = new THREE.LineSegments(
			new THREE.EdgesGeometry(geometry, 30),
			new THREE.LineBasicMaterial({ color: 0x14243a, transparent: true, opacity: 0.35 })
		);
		this.scene.add(this.edges);

		this.frame(geometry);
	}

	setEdgesVisible(visible) {
		if (this.edges) this.edges.visible = visible;
	}

	/** モデル全体が収まるようカメラとグリッドを合わせる */
	frame(geometry) {
		geometry.computeBoundingBox();

		const box = geometry.boundingBox;
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const radius = Math.max(size.length() / 2, 1e-3);
		const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);

		this.camera.near = Math.max(distance / 1000, 0.01);
		this.camera.far = distance * 100;
		this.camera.position.copy(center).add(new THREE.Vector3(0.15, -1, 0.75).normalize().multiplyScalar(distance * 1.25));
		this.camera.updateProjectionMatrix();

		this.controls.target.copy(center);
		this.controls.update();

		const gridSize = Math.pow(10, Math.ceil(Math.log10(Math.max(size.x, size.y, 1)))) * 2;
		this.scene.remove(this.grid);
		this.grid.geometry.dispose();
		this.grid.material.dispose();
		this.grid = new THREE.GridHelper(gridSize, 20, 0x8899aa, 0x33404d);
		this.grid.rotation.x = Math.PI / 2;
		this.grid.position.z = box.min.z;
		this.scene.add(this.grid);
	}
}

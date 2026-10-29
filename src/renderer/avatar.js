// VRM avatar (three.js + @pixiv/three-vrm) with idle motion, blinking and lip-sync.
// Falls back to a simple placeholder figure if no .vrm is configured.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export async function createAvatar(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: opts.antialias !== false, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio || 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov || 28, 1, 0.1, 20);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(0.5, 1.5, 2);
  scene.add(light);

  let vrm = null;
  let placeholder = null;
  let info = { kind: 'placeholder' };

  if (opts.vrmBuffer) {
    try {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const ab = opts.vrmBuffer.buffer.slice(opts.vrmBuffer.byteOffset, opts.vrmBuffer.byteOffset + opts.vrmBuffer.byteLength);
      const gltf = await loader.parseAsync(ab, '');
      vrm = gltf.userData.vrm;
      if (!vrm) throw new Error('файл не содержит VRM');
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons ? VRMUtils.combineSkeletons(gltf.scene) : VRMUtils.removeUnnecessaryJoints?.(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM0 models face -Z; make them face the camera
      vrm.scene.traverse((o) => { o.frustumCulled = false; });
      scene.add(vrm.scene);
      relaxArms(vrm);
      info = { kind: 'vrm', version: vrm.meta?.metaVersion || '?', name: vrm.meta?.name || vrm.meta?.title || '' };
    } catch (e) {
      console.error('VRM load failed', e);
      info = { kind: 'placeholder', error: String(e.message || e) };
      vrm = null;
    }
  }
  if (!vrm) { placeholder = makePlaceholder(); scene.add(placeholder.group); }

  // camera framing: upper body
  function frame() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    let headY = 1.4;
    if (vrm) { const head = vrm.humanoid?.getNormalizedBoneNode('head'); if (head) { const p = new THREE.Vector3(); head.getWorldPosition(p); headY = p.y; } }
    const zoom = opts.zoom || 1.8;
    const targetY = headY - (vrm ? 0.24 : 0.3) * (opts.bodyFraction || 1);
    camera.position.set(0, targetY + 0.05, ((opts.distance || 1.6) * (vrm ? 1 : 1.9)) / zoom);
    camera.lookAt(0, targetY, 0);
  }
  window.addEventListener('resize', frame);

  const clock = new THREE.Clock();
  let mouth = 0, mouthTarget = 0, blinkT = 0, nextBlink = 2 + Math.random() * 3, t = 0;
  let speaking = false;

  function setMouth(v) { mouthTarget = Math.max(0, Math.min(1, v)); }
  function setSpeaking(v) { speaking = v; }

  function blinkValue(dt) {
    blinkT += dt;
    if (blinkT > nextBlink) {
      const k = (blinkT - nextBlink) / 0.15; // 150 ms blink
      if (k >= 1) { blinkT = 0; nextBlink = 2 + Math.random() * 4; return 0; }
      return Math.sin(k * Math.PI);
    }
    return 0;
  }

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    t += dt;
    mouth += (mouthTarget - mouth) * Math.min(1, dt * 18);
    const blink = blinkValue(dt);
    if (vrm) {
      const em = vrm.expressionManager;
      if (em) {
        em.setValue('blink', blink);
        em.setValue('aa', mouth * 0.9);
        em.setValue('oh', speaking ? mouth * 0.25 * (0.5 + 0.5 * Math.sin(t * 9)) : 0);
        em.setValue('happy', opts.smile ?? 0.15);
      }
      const h = vrm.humanoid;
      const breathe = Math.sin(t * 1.6);
      const spine = h?.getNormalizedBoneNode('spine');
      if (spine) { spine.rotation.x = breathe * 0.015; spine.rotation.z = Math.sin(t * 0.5) * 0.02; }
      const chest = h?.getNormalizedBoneNode('chest');
      if (chest) chest.rotation.x = breathe * 0.01;
      const neck = h?.getNormalizedBoneNode('neck');
      if (neck) { neck.rotation.y = Math.sin(t * 0.37) * 0.08; neck.rotation.x = Math.sin(t * 0.53) * 0.03 + (speaking ? Math.sin(t * 6) * 0.015 : 0); neck.rotation.z = Math.sin(t * 0.29) * 0.04; }
      const lArm = h?.getNormalizedBoneNode('leftUpperArm');
      const rArm = h?.getNormalizedBoneNode('rightUpperArm');
      // normalized VRM bones: negative z lowers the left arm, positive lowers the right one
      if (lArm) lArm.rotation.z = 1.25 + Math.sin(t * 1.6) * 0.02;
      if (rArm) rArm.rotation.z = -1.25 - Math.sin(t * 1.6) * 0.02;
      vrm.update(dt);
    } else placeholder.update(t, blink, mouth);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  frame();
  // re-frame after first update (bones settle)
  if (vrm) { vrm.update(0); frame(); }
  requestAnimationFrame(tick);
  return { setMouth, setSpeaking, info };
}

function relaxArms(vrm) {
  const h = vrm.humanoid;
  for (const [n, z] of [['leftLowerArm', -0.15], ['rightLowerArm', 0.15]]) { const b = h?.getNormalizedBoneNode(n); if (b) b.rotation.z = z; }
}

// Cute low-poly placeholder so the app works without a model.
function makePlaceholder() {
  const group = new THREE.Group();
  const skin = new THREE.MeshToonMaterial({ color: 0xffe0d0 });
  const hair = new THREE.MeshToonMaterial({ color: 0x55c7d9 });
  const dark = new THREE.MeshBasicMaterial({ color: 0x2a2140 });
  const pink = new THREE.MeshBasicMaterial({ color: 0xd8506e });
  const cloth = new THREE.MeshToonMaterial({ color: 0x2f2f45 });

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 24), skin); head.position.y = 1.45; group.add(head);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.175, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.5), hair); hairCap.position.set(0, 1.46, -0.01); hairCap.rotation.x = -0.55; group.add(hairCap);
  for (const s of [-1, 1]) {
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.45, 6, 12), hair); tail.position.set(0.2 * s, 1.3, -0.05); tail.rotation.z = 0.25 * s; group.add(tail);
  }
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 12), dark); e.position.set(0.058 * s, 1.46, 0.145); e.scale.set(1, 1.35, 0.4); group.add(e); eyes.push(e);
  }
  const mouthM = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), pink); mouthM.position.set(0, 1.37, 0.152); mouthM.scale.set(1.2, 0.15, 0.3); group.add(mouthM);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.32, 8, 16), cloth); body.position.y = 1.08; group.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 12), skin); neck.position.y = 1.3; group.add(neck);

  return {
    group,
    update(t, blink, mouth) {
      group.position.y = Math.sin(t * 1.6) * 0.006;
      head.rotation.set(Math.sin(t * 0.53) * 0.04, Math.sin(t * 0.37) * 0.1, Math.sin(t * 0.29) * 0.05);
      hairCap.rotation.y = head.rotation.y;
      for (const e of eyes) e.scale.y = 1.35 * (1 - blink * 0.92);
      mouthM.scale.y = 0.15 + mouth * 1.1;
    },
  };
}

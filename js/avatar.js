/**
 * avatar.js — Local and remote avatar rendering
 *
 * Each avatar consists of:
 *  - Head: rounded box with eye dots
 *  - Left hand: either grip box (controller) or 25-joint skeleton (hand tracking)
 *  - Right hand: same
 *  - Name label: canvas texture sprite above head
 *  - Emoji float: temporary 2D emoji above head
 *
 * State schema (serialized over the network):
 * {
 *   head: { p:[x,y,z], q:[x,y,z,w] },
 *   hands: {
 *     left:  { mode:'controller'|'hand'|null, p:[x,y,z], q:[x,y,z,w], joints:[...25 {p,q}] },
 *     right: { mode:'controller'|'hand'|null, p:[x,y,z], q:[x,y,z,w], joints:[...25 {p,q}] },
 *   },
 *   name: string,
 * }
 */

import * as THREE from 'three';

// Hand joint indices (XRHand spec order)
const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip',
  'index-finger-metacarpal','index-finger-phalanx-proximal','index-finger-phalanx-intermediate','index-finger-phalanx-distal','index-finger-tip',
  'middle-finger-metacarpal','middle-finger-phalanx-proximal','middle-finger-phalanx-intermediate','middle-finger-phalanx-distal','middle-finger-tip',
  'ring-finger-metacarpal','ring-finger-phalanx-proximal','ring-finger-phalanx-intermediate','ring-finger-phalanx-distal','ring-finger-tip',
  'pinky-finger-metacarpal','pinky-finger-phalanx-proximal','pinky-finger-phalanx-intermediate','pinky-finger-phalanx-distal','pinky-finger-tip',
];

// Finger bone connections: [from_index, to_index]
const FINGER_BONES = [
  [0,1],[1,2],[2,3],[3,4],       // thumb
  [0,5],[5,6],[6,7],[7,8],[8,9], // index
  [0,10],[10,11],[11,12],[12,13],[13,14], // middle
  [0,15],[15,16],[16,17],[17,18],[18,19], // ring
  [0,20],[20,21],[21,22],[22,23],[23,24], // pinky
];

const AVATAR_COLORS = [
  0x4fc3f7, 0xf06292, 0x81c784, 0xffb74d,
  0xce93d8, 0x4dd0e1, 0xff8a65, 0xa5d6a7,
];

let _colorIndex = 0;
function nextColor() { return AVATAR_COLORS[_colorIndex++ % AVATAR_COLORS.length]; }

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLabelCanvas(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `#${color.toString(16).padStart(6,'0')}cc`;
  ctx.roundRect(0, 0, 256, 64, 12);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name || 'Guest', 128, 32);
  return canvas;
}

function makeNameSprite(name, color) {
  const tex = new THREE.CanvasTexture(makeLabelCanvas(name, color));
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.1, 1);
  return sprite;
}

function makeBone(length = 0.02, radius = 0.004) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, 6);
  geo.translate(0, length / 2, 0);
  return geo;
}

// ─── RemoteAvatar ───────────────────────────────────────────────────────────

export class RemoteAvatar {
  constructor(peerId, scene) {
    this.peerId = peerId;
    this.scene  = scene;
    this.color  = nextColor();
    this.root   = new THREE.Group();
    scene.add(this.root);

    // Head
    const headGeo = new THREE.BoxGeometry(0.18, 0.22, 0.2);
    const headMat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.7 });
    this.head = new THREE.Mesh(headGeo, headMat);
    this.root.add(this.head);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.02, 8, 8);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.045, 0.02, 0.101);
    eyeR.position.set( 0.045, 0.02, 0.101);
    this.head.add(eyeL, eyeR);

    // Name label
    this.nameSprite = makeNameSprite(peerId.slice(-5), this.color);
    this.nameSprite.position.set(0, 0.18, 0);
    this.head.add(this.nameSprite);

    // Emoji float group (above head)
    this.emojiGroup = new THREE.Group();
    this.emojiGroup.position.set(0, 0.32, 0);
    this.head.add(this.emojiGroup);
    this._emojiTimer = null;

    // Hands
    this.handMat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.5 });
    this.hands = {
      left:  this._makeHandGroup(),
      right: this._makeHandGroup(),
    };
    this.root.add(this.hands.left.root, this.hands.right.root);
  }

  _makeHandGroup() {
    const root = new THREE.Group();
    // Controller grip box
    const gripGeo = new THREE.BoxGeometry(0.04, 0.12, 0.04);
    const grip = new THREE.Mesh(gripGeo, this.handMat);
    root.add(grip);
    root._grip = grip;

    // Joint spheres (25) + bones (edges)
    const jointGeo = new THREE.SphereGeometry(0.007, 6, 6);
    const joints = JOINT_NAMES.map(() => {
      const m = new THREE.Mesh(jointGeo, this.handMat);
      root.add(m);
      return m;
    });
    root._joints = joints;

    // Bone cylinders
    const boneGeo = makeBone();
    const bones = FINGER_BONES.map(() => {
      const m = new THREE.Mesh(boneGeo.clone(), this.handMat);
      root.add(m);
      return m;
    });
    root._bones = bones;

    this._setHandMode(root, null);
    return root;
  }

  _setHandMode(handRoot, mode) {
    handRoot._grip.visible = mode === 'controller';
    const showJoints = mode === 'hand';
    handRoot._joints.forEach(j => j.visible = showJoints);
    handRoot._bones.forEach(b => b.visible = showJoints);
  }

  _updateBones(handRoot, jointPositions) {
    FINGER_BONES.forEach(([a, b], i) => {
      const bone = handRoot._bones[i];
      if (!bone.visible) return;
      const pA = new THREE.Vector3().fromArray(jointPositions[a]);
      const pB = new THREE.Vector3().fromArray(jointPositions[b]);
      const dir = new THREE.Vector3().subVectors(pB, pA);
      const len = dir.length();
      bone.position.copy(pA);
      bone.scale.y = len / 0.02;
      bone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.normalize());
    });
  }

  applyState(state) {
    if (!state) return;

    // Head
    if (state.head) {
      this.head.position.fromArray(state.head.p);
      this.head.quaternion.fromArray(state.head.q);
    }

    // Hands
    for (const side of ['left', 'right']) {
      const hs = state.hands?.[side];
      const hg = this.hands[side];
      if (!hs || hs.mode === null) {
        hg.root.visible = false;
        continue;
      }
      hg.root.visible = true;
      this._setHandMode(hg.root, hs.mode);
      hg.root.position.fromArray(hs.p);
      hg.root.quaternion.fromArray(hs.q);

      if (hs.mode === 'hand' && hs.joints) {
        hs.joints.forEach((j, i) => {
          hg.root._joints[i].position.fromArray(j.p);
        });
        this._updateBones(hg.root, hs.joints.map(j => j.p));
      }
    }

    // Name
    if (state.name) this._updateName(state.name);
  }

  _updateName(name) {
    if (this._lastName === name) return;
    this._lastName = name;
    const tex = new THREE.CanvasTexture(makeLabelCanvas(name, this.color));
    this.nameSprite.material.map.dispose();
    this.nameSprite.material.map = tex;
    this.nameSprite.material.needsUpdate = true;
  }

  showEmoji(emoji) {
    // Clear any existing emoji
    this.emojiGroup.clear();
    if (this._emojiTimer) clearTimeout(this._emojiTimer);

    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = '80px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 64, 64);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.15, 0.15, 1);
    this.emojiGroup.add(sprite);

    this._emojiTimer = setTimeout(() => this.emojiGroup.clear(), 4000);
  }

  dispose() {
    this.scene.remove(this.root);
    if (this._emojiTimer) clearTimeout(this._emojiTimer);
  }
}

// ─── LocalAvatar ─────────────────────────────────────────────────────────────
// Reads XRFrame data and serializes it for transmission.

export class LocalAvatar {
  constructor(name = 'Guest') {
    this.name = name;
  }

  /**
   * Reads pose from an XRFrame and returns a serializable state object.
   * @param {XRFrame} frame
   * @param {XRReferenceSpace} refSpace
   * @param {XRInputSource[]} inputSources
   */
  getState(frame, refSpace, inputSources) {
    const headPose = frame.getViewerPose(refSpace);
    const state = {
      name: this.name,
      head: null,
      hands: { left: null, right: null },
    };

    if (headPose) {
      const t = headPose.transform.position;
      const r = headPose.transform.orientation;
      state.head = {
        p: [t.x, t.y, t.z],
        q: [r.x, r.y, r.z, r.w],
      };
    }

    for (const src of inputSources) {
      const side = src.handedness; // 'left' | 'right'
      if (side !== 'left' && side !== 'right') continue;

      if (src.hand) {
        // Hand tracking mode
        const joints = [];
        let ok = true;
        for (const jointName of JOINT_NAMES) {
          const joint = src.hand.get(jointName);
          if (!joint) { ok = false; break; }
          const pose = frame.getJointPose(joint, refSpace);
          if (!pose) { ok = false; break; }
          const { position: p, orientation: q } = pose.transform;
          joints.push({ p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] });
        }
        if (ok) {
          const wrist = joints[0];
          state.hands[side] = {
            mode: 'hand',
            p: wrist.p,
            q: wrist.q,
            joints,
          };
        }
      } else if (src.gripSpace) {
        // Controller mode
        const pose = frame.getPose(src.gripSpace, refSpace);
        if (pose) {
          const { position: p, orientation: q } = pose.transform;
          state.hands[side] = {
            mode: 'controller',
            p: [p.x, p.y, p.z],
            q: [q.x, q.y, q.z, q.w],
            joints: null,
          };
        }
      }
    }

    return state;
  }
}

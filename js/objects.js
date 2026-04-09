/**
 * objects.js — Shared grabbable AR objects
 *
 * Objects are spawned in front of the user's head and are
 * identified by a UUID so they can be synced across peers.
 *
 * Grabbing uses ray-cast (pointer mode) OR proximity grab (hand tracking):
 *  - Controller: trigger button on the hand closest to the object while
 *                the controller ray intersects the object.
 *  - Hand: pinch gesture (index-tip <-> thumb-tip distance < PINCH_THRESHOLD)
 *           while near the object.
 *
 * Ownership: only one peer can move an object at a time.
 *  - obj-grab   { id, owner, ts }  -> locks the object (ts for race resolution)
 *  - obj-state  { id, p, q }       -> streaming position while grabbed (throttled)
 *  - obj-release{ id, p, q }       -> final position + unlocks
 *  - obj-delete { id }             -> removes object entirely
 */

import * as THREE from 'three';
import { dbg, dbgWarn } from './debug.js';

const PINCH_THRESHOLD = 0.025; // metres
const OBJ_BROADCAST_INTERVAL = 50; // ms (~20fps for object state)

let _uidCounter = 0;
function uid(peerId) {
  return `obj-${peerId}-${Date.now()}-${_uidCounter++}`;
}

const SHAPE_FACTORIES = {
  cube:   () => new THREE.BoxGeometry(0.12, 0.12, 0.12),
  sphere: () => new THREE.SphereGeometry(0.07, 16, 12),
  torus:  () => new THREE.TorusGeometry(0.07, 0.025, 12, 32),
};

const OBJECT_COLORS = [0xff6b6b, 0xffa94d, 0xffe066, 0x69db7c, 0x4dabf7, 0xda77f2];
let _colorIdx = 0;

export class SharedObjects {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./network.js').Network} network
   * @param {string} localPeerId
   */
  constructor(scene, network, localPeerId) {
    this.scene       = scene;
    this.network     = network;
    this.localPeerId = localPeerId;
    this.objects     = new Map(); // id -> { mesh, owner, id, grabTs }

    this._heldLeft   = null; // id of object held in left hand
    this._heldRight  = null;

    // Raycaster for controller grab
    this._raycaster  = new THREE.Raycaster();

    // Throttle for object state broadcasts
    this._lastObjBroadcast = 0;
  }

  // ── Spawning ──────────────────────────────────────────────────────────────

  spawnAt(shape, position, quaternion) {
    const id    = uid(this.localPeerId);
    const color = OBJECT_COLORS[_colorIdx++ % OBJECT_COLORS.length];
    const def   = {
      id, shape, color,
      p: position.toArray(),
      q: quaternion.toArray(),
    };
    this._addObject(def);
    this.network.broadcast({ type: 'obj-spawn', payload: def });
    dbg('OBJ', `spawn ${shape} id=${id}`);
  }

  applyRemoteSpawn(def) {
    if (!this.objects.has(def.id)) {
      this._addObject(def);
      dbg('OBJ', `remote spawn ${def.shape} id=${def.id}`);
    }
  }

  _addObject({ id, shape, color, p, q }) {
    const geo  = (SHAPE_FACTORIES[shape] || SHAPE_FACTORIES.cube)();
    const mat  = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.fromArray(p);
    mesh.quaternion.fromArray(q);
    mesh.castShadow = true;
    mesh.userData.objId = id;
    mesh.userData.shape = shape;  // store shape for reliable getAllDefs()
    this.scene.add(mesh);
    this.objects.set(id, { mesh, owner: null, id, grabTs: 0 });
  }

  // ── Remote state updates ──────────────────────────────────────────────────

  applyRemoteGrab(payload) {
    const obj = this.objects.get(payload.id);
    if (!obj) return;

    const incomingTs = payload.ts || 0;

    // Resolve simultaneous grab race: if we own it and our grab is newer, reject
    if (obj.owner === this.localPeerId && (obj.grabTs || 0) > incomingTs) {
      dbg('OBJ', `rejected stale grab on ${payload.id} from ${payload.owner} (our ts=${obj.grabTs} > ${incomingTs})`);
      return;
    }

    dbg('OBJ', `remote grab ${payload.id} by ${payload.owner}`);
    obj.owner  = payload.owner;
    obj.grabTs = incomingTs;
  }

  applyRemoteState(payload) {
    const obj = this.objects.get(payload.id);
    if (!obj || obj.owner === this.localPeerId) return; // we own it
    obj.mesh.position.fromArray(payload.p);
    obj.mesh.quaternion.fromArray(payload.q);
  }

  applyRemoteRelease(payload) {
    const obj = this.objects.get(payload.id);
    if (!obj) return;
    dbg('OBJ', `remote release ${payload.id}`);
    obj.owner = null;
    obj.mesh.position.fromArray(payload.p);
    obj.mesh.quaternion.fromArray(payload.q);
  }

  applyRemoteDelete(payload) {
    const obj = this.objects.get(payload.id);
    if (!obj) return;
    dbg('OBJ', `delete ${payload.id}`);
    this.scene.remove(obj.mesh);
    this.objects.delete(payload.id);
  }

  // ── Local input polling (called from render loop) ─────────────────────────

  /**
   * Called every frame with current XR input sources and frame.
   * @param {XRFrame} frame
   * @param {XRReferenceSpace} refSpace
   * @param {XRInputSource[]} inputSources
   */
  update(frame, refSpace, inputSources) {
    for (const src of inputSources) {
      const side = src.handedness;
      if (side !== 'left' && side !== 'right') continue;

      const heldId = side === 'left' ? this._heldLeft : this._heldRight;

      if (src.hand) {
        this._handleHandGrab(frame, refSpace, src, side, heldId);
      } else {
        this._handleControllerGrab(frame, refSpace, src, side, heldId);
      }

      // If holding, stream the object's current position (throttled)
      const currentHeld = side === 'left' ? this._heldLeft : this._heldRight;
      if (currentHeld) {
        const now = performance.now();
        if (now - this._lastObjBroadcast > OBJ_BROADCAST_INTERVAL) {
          this._lastObjBroadcast = now;
          const obj = this.objects.get(currentHeld);
          if (obj) {
            this.network.broadcast({
              type: 'obj-state',
              payload: {
                id: obj.id,
                p: obj.mesh.position.toArray(),
                q: obj.mesh.quaternion.toArray(),
              },
            });
          }
        }
      }
    }
  }

  _handleHandGrab(frame, refSpace, src, side, heldId) {
    const indexTip = src.hand.get('index-finger-tip');
    const thumbTip = src.hand.get('thumb-tip');
    if (!indexTip || !thumbTip) return;

    const iPose = frame.getJointPose(indexTip, refSpace);
    const tPose = frame.getJointPose(thumbTip, refSpace);
    if (!iPose || !tPose) return;

    const ip = iPose.transform.position;
    const tp = tPose.transform.position;
    const iPos = new THREE.Vector3(ip.x, ip.y, ip.z);
    const tPos = new THREE.Vector3(tp.x, tp.y, tp.z);

    const pinching = iPos.distanceTo(tPos) < PINCH_THRESHOLD;
    const pinchPoint = new THREE.Vector3().addVectors(iPos, tPos).multiplyScalar(0.5);

    if (pinching && !heldId) {
      // Find nearest unowned object within grab range
      let nearest = null, nearestDist = 0.15;
      for (const [id, obj] of this.objects) {
        if (obj.owner && obj.owner !== this.localPeerId) continue;
        const d = obj.mesh.position.distanceTo(pinchPoint);
        if (d < nearestDist) { nearest = id; nearestDist = d; }
      }
      if (nearest) this._grab(nearest, side, pinchPoint);
    } else if (!pinching && heldId) {
      this._release(heldId, side);
    } else if (pinching && heldId) {
      // Move object to pinch point
      const obj = this.objects.get(heldId);
      if (obj) obj.mesh.position.copy(pinchPoint);
    }
  }

  _handleControllerGrab(frame, refSpace, src, side, heldId) {
    const trigger = src.gamepad?.buttons[0];
    const pressed = trigger?.pressed ?? false;

    if (pressed && !heldId && src.targetRaySpace) {
      const rayPose = frame.getPose(src.targetRaySpace, refSpace);
      if (!rayPose) return;

      const { position: rp, orientation: rq } = rayPose.transform;
      const origin = new THREE.Vector3(rp.x, rp.y, rp.z);
      const direction = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w))
        .normalize();

      this._raycaster.set(origin, direction);
      const meshes = [...this.objects.values()].map(o => o.mesh);
      const hits = this._raycaster.intersectObjects(meshes);
      if (hits.length > 0) {
        const hitId = hits[0].object.userData.objId;
        const obj = this.objects.get(hitId);
        if (!obj.owner || obj.owner === this.localPeerId) {
          this._grab(hitId, side, hits[0].point);
        }
      }
    } else if (!pressed && heldId) {
      this._release(heldId, side);
    } else if (pressed && heldId && src.gripSpace) {
      // Drag with grip pose
      const gripPose = frame.getPose(src.gripSpace, refSpace);
      if (gripPose) {
        const obj = this.objects.get(heldId);
        if (obj) {
          const { position: p, orientation: q } = gripPose.transform;
          obj.mesh.position.set(p.x, p.y - 0.05, p.z);
          obj.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        }
      }
    }
  }

  _grab(id, side, _point) {
    const obj = this.objects.get(id);
    if (!obj) return;
    const ts = Date.now();
    obj.owner  = this.localPeerId;
    obj.grabTs = ts;
    if (side === 'left') this._heldLeft = id;
    else this._heldRight = id;
    dbg('OBJ', `grab ${id} ts=${ts}`);
    this.network.broadcast({ type: 'obj-grab', payload: { id, owner: this.localPeerId, ts } });
  }

  _release(id, side) {
    const obj = this.objects.get(id);
    if (side === 'left') this._heldLeft = null;
    else this._heldRight = null;
    if (!obj) return;
    dbg('OBJ', `release ${id}`);
    obj.owner = null;
    this.network.broadcast({
      type: 'obj-release',
      payload: {
        id,
        p: obj.mesh.position.toArray(),
        q: obj.mesh.quaternion.toArray(),
      },
    });
  }

  /** Delete object under the given controller ray (long-press / B button). */
  tryDeleteUnderRay(frame, refSpace, src) {
    if (!src.targetRaySpace) return;
    const rayPose = frame.getPose(src.targetRaySpace, refSpace);
    if (!rayPose) return;

    const { position: dp, orientation: dq } = rayPose.transform;
    const origin = new THREE.Vector3(dp.x, dp.y, dp.z);
    const direction = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(new THREE.Quaternion(dq.x, dq.y, dq.z, dq.w))
      .normalize();

    this._raycaster.set(origin, direction);
    const hits = this._raycaster.intersectObjects([...this.objects.values()].map(o => o.mesh));
    if (hits.length > 0) {
      const id = hits[0].object.userData.objId;
      this.applyRemoteDelete({ id });
      this.network.broadcast({ type: 'obj-delete', payload: { id } });
    }
  }

  /** Returns all object defs (for syncing to newly joined peers). */
  getAllDefs() {
    return [...this.objects.values()].map(({ mesh, id }) => ({
      id,
      shape: mesh.userData.shape || 'cube',
      color: mesh.material.color.getHex(),
      p: mesh.position.toArray(),
      q: mesh.quaternion.toArray(),
    }));
  }
}

/**
 * debug.js — Toggleable debug logging
 *
 * Enable via:
 *   URL param:  ?debug=1
 *   Console:    window.xrDebug = true
 *
 * Tags: NET, APP, OBJ, AVATAR
 */

const params = new URLSearchParams(window.location.search);
let _enabled = params.has('debug');

Object.defineProperty(window, 'xrDebug', {
  get: () => _enabled,
  set: v => {
    _enabled = !!v;
    console.log(`[XR] debug logging ${_enabled ? 'ON' : 'OFF'}`);
  },
});

export function dbg(tag, ...args) {
  if (_enabled) console.log(`[XR:${tag}]`, ...args);
}

export function dbgWarn(tag, ...args) {
  if (_enabled) console.warn(`[XR:${tag}]`, ...args);
}

/** Errors always log regardless of toggle. */
export function dbgError(tag, ...args) {
  console.error(`[XR:${tag}]`, ...args);
}

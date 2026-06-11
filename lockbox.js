// lockbox.js — hardware interface stub
// When your relay/GPIO hardware is ready, replace the stub functions below.
//
// Example with the 'onoff' package (Pi GPIO):
//   const { Gpio } = require('onoff');
//   const relay = new Gpio(17, 'out'); // GPIO pin 17
//   async function unlock() { await relay.write(1); }
//   async function lock()   { await relay.write(0); }
//
// Example with pigpio:
//   const pigpio = require('pigpio');
//   const motor = new pigpio.Gpio(17, { mode: pigpio.Gpio.OUTPUT });
//   async function unlock() { motor.digitalWrite(1); }
//   async function lock()   { motor.digitalWrite(0); }

let _locked = false;

async function lock() {
  console.log('[Lockbox] LOCK signal sent (stub)');
  _locked = true;
  return { ok: true };
}

async function unlock() {
  console.log('[Lockbox] UNLOCK signal sent (stub)');
  _locked = false;
  return { ok: true };
}

function isLocked() {
  return _locked;
}

module.exports = { lock, unlock, isLocked };

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const PISHOCK_URL = 'https://do.pishock.com/api/apioperate';

const OP = { SHOCK: 0, VIBRATE: 1, BEEP: 2 };
const OP_NAMES = { 0: 'shock', 1: 'vibrate', 2: 'beep' };

async function operate(credentials, { op, intensity, duration, name = 'AlarmBot' }) {
  const body = {
    Username: credentials.username,
    Apikey: credentials.apikey,
    Code: credentials.sharecode,
    Name: name,
    Op: op,
    Duration: Math.min(Math.max(1, duration), 15),
    Intensity: Math.min(Math.max(0, intensity), 100),
  };
  console.log('[PiShock] Sending:', JSON.stringify(body));
  try {
    const res = await fetch(PISHOCK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[PiShock debug]', res.status, text);
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    console.error('[PiShock] Request failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function shock(credentials, intensity, duration) {
  return operate(credentials, { op: OP.SHOCK, intensity, duration });
}

async function vibrate(credentials, intensity, duration) {
  return operate(credentials, { op: OP.VIBRATE, intensity, duration });
}

async function beep(credentials, duration) {
  return operate(credentials, { op: OP.BEEP, intensity: 0, duration });
}

async function test(credentials) {
  // Always vibrate for test — never shock
  return vibrate(credentials, 20, 1);
}

module.exports = { OP, OP_NAMES, operate, shock, vibrate, beep, test };

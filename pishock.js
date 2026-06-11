const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const OP = { SHOCK: 0, VIBRATE: 1, BEEP: 2 };
const OP_NAMES = { 0: 'shock', 1: 'vibrate', 2: 'beep' };

async function resolveCredentials(username, apikey, sharecode) {
  const authRes = await fetch(
    `https://auth.pishock.com/Auth/GetUserIfAPIKeyValid?apikey=${encodeURIComponent(apikey)}&username=${encodeURIComponent(username)}`
  );
  if (!authRes.ok) throw new Error(`Auth request failed: ${authRes.status}`);
  const authData = await authRes.json();
  const userId = authData.UserId;
  if (!userId) throw new Error('Could not find UserId in auth response');

  return { userId, username, apikey, sharecode };
}

async function operate(credentials, { op, intensity, duration }) {
  const body = {
    Username: credentials.username,
    Apikey: credentials.apikey,
    Code: credentials.sharecode,
    Name: 'AlarmBot',
    Op: op,
    Duration: Math.min(Math.max(1, duration), 15),
    Intensity: Math.min(Math.max(0, intensity), 100),
  };

  console.log('[PiShock] Sending:', JSON.stringify(body));

  try {
    const res = await fetch('https://do.pishock.com/api/apioperate/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[PiShock] Response:', res.status, text);
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
  return vibrate(credentials, 20, 1);
}

module.exports = { OP, OP_NAMES, operate, shock, vibrate, beep, test, resolveCredentials };

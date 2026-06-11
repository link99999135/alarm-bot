const cron = require('node-cron');
const { DateTime } = require('luxon');
const {
  getDueAlarms, rescheduleAlarm, incrementSnooze,
  createDismissChallenge, markDismissed,
  getPishockCredentials, getUser,
  getDueScheduledUnlocks, setUnlocked,
} = require('./db');
const pishock = require('./pishock');
const lockbox = require('./lockbox');

// Active firing alarms: alarmId -> { intervalId, client, userId }
const firingAlarms = new Map();

function startScheduler(client) {
  // Check alarms every minute
  cron.schedule('* * * * *', () => tickAlarms(client));
  // Check scheduled lockbox unlocks every minute
  cron.schedule('* * * * *', () => tickScheduledUnlocks(client));
  console.log('[Scheduler] Started');
}

async function tickAlarms(client) {
  const due = getDueAlarms();
  for (const alarm of due) {
    if (firingAlarms.has(alarm.id)) continue;
    fireAlarm(client, alarm);
  }
}

async function fireAlarm(client, alarm) {
  console.log(`[Scheduler] Firing alarm ${alarm.id} for user ${alarm.user_id}`);

  const { phrase, snoozePhrase } = createDismissChallenge(alarm.id);
  const user = getUser(alarm.user_id);

  // Send initial Discord message
  await sendAlarmMessage(client, alarm, phrase, snoozePhrase);

  if (!alarm.shock_enabled) return;

  // Start repeating shock interval
  const credentials = getPishockCredentials(alarm.user_id);
  if (!credentials) return;

  // Fire immediately
  await pishockOperate(credentials, alarm);

  // Then repeat every 30 seconds until dismissed
  const intervalId = setInterval(async () => {
    if (!firingAlarms.has(alarm.id)) return;
    await pishockOperate(credentials, alarm);
  }, 30_000);

  firingAlarms.set(alarm.id, { intervalId, client, userId: alarm.user_id });
}

async function pishockOperate(credentials, alarm) {
  try {
    await pishock.operate(credentials, {
      op: alarm.shock_op,
      intensity: alarm.shock_intensity,
      duration: alarm.shock_duration,
    });
  } catch (err) {
    console.error(`[Scheduler] PiShock error for alarm ${alarm.id}:`, err.message);
  }
}

async function sendAlarmMessage(client, alarm, phrase, snoozePhrase, isReshock = false) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

  try {
    const user = await client.users.fetch(alarm.user_id);
    const snoozeLeft = alarm.max_snoozes - alarm.snooze_count;
    const canSnooze = snoozeLeft > 0;

    const embed = new EmbedBuilder()
      .setColor(alarm.shock_enabled ? 0xE24B4A : 0x7F77DD)
      .setTitle(`⏰ ${alarm.label || 'Alarm'}`)
      .setDescription(
        alarm.shock_enabled
          ? `**Type this phrase exactly to dismiss:**\n\`\`\`${phrase}\`\`\`${canSnooze ? `\nTo snooze, type: \`${snoozePhrase}\` (${snoozeLeft} snooze${snoozeLeft !== 1 ? 's' : ''} left)` : '\n**No snoozes remaining — you must type the dismiss phrase.**'}`
          : `Your alarm is going off!\nLabel: **${alarm.label || 'none'}**`
      )
      .setTimestamp();

    const row = new ActionRowBuilder();
    if (!alarm.shock_enabled) {
      if (canSnooze) {
        row.addComponents(
          new ButtonBuilder().setCustomId(`snooze_${alarm.id}`).setLabel('Snooze 5min').setStyle(ButtonStyle.Secondary),
        );
      }
      row.addComponents(
        new ButtonBuilder().setCustomId(`dismiss_${alarm.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Primary),
      );
    }

    const components = (!alarm.shock_enabled && row.components.length) ? [row] : [];
    await user.send({ embeds: [embed], components });
  } catch (err) {
    console.error(`[Scheduler] Failed to send alarm message for ${alarm.id}:`, err.message);
    // Fallback: try channel
    if (alarm.channel_id) {
      try {
        const channel = await client.channels.fetch(alarm.channel_id);
        await channel.send(`<@${alarm.user_id}> ⏰ **${alarm.label || 'Alarm'}** — check your DMs!`);
      } catch {}
    }
  }
}

function stopFiringAlarm(alarmId) {
  const entry = firingAlarms.get(alarmId);
  if (entry) {
    clearInterval(entry.intervalId);
    firingAlarms.delete(alarmId);
  }
}

function isFiring(alarmId) {
  return firingAlarms.has(alarmId);
}

// Escalate: fire an immediate shock for a wrong dismiss attempt
async function penaltyShock(userId, alarm) {
  const credentials = getPishockCredentials(userId);
  if (!credentials || !alarm.shock_enabled) return;
  await pishock.operate(credentials, {
    op: pishock.OP.SHOCK,
    intensity: Math.min(alarm.shock_intensity + 10, 100),
    duration: 1,
  });
}

async function tickScheduledUnlocks(client) {
  const due = getDueScheduledUnlocks();
  for (const pair of due) {
    try {
      await lockbox.unlock();
      setUnlocked(pair.wearer_id);
      console.log(`[Scheduler] Scheduled unlock fired for wearer ${pair.wearer_id}`);
      const wearer = await client.users.fetch(pair.wearer_id);
      await wearer.send('🔓 Your scheduled unlock time has arrived. The lockbox has been opened.');
      const keyholder = await client.users.fetch(pair.keyholder_id);
      await keyholder.send(`🔓 Scheduled unlock fired for <@${pair.wearer_id}>.`);
    } catch (err) {
      console.error('[Scheduler] Scheduled unlock error:', err.message);
    }
  }
}

module.exports = { startScheduler, stopFiringAlarm, isFiring, penaltyShock, sendAlarmMessage };

require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const {
  getDismissChallenge, markDismissed, incrementDismissAttempt,
  incrementSnooze, getAlarm, rescheduleAlarm,
} = require('./db');
const { startScheduler, stopFiringAlarm, isFiring, penaltyShock } = require('./scheduler');
const lockCmd = require('./commands/lock');

// ── Client setup ──────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();

// Load all command files
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  startScheduler(client);
});

// ── Slash commands ────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`[Bot] Command error (${interaction.commandName}):`, err);
      const msg = { content: 'Something went wrong running that command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply(msg);
    }
  }

  if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

// ── Button interactions ───────────────────────────────────────────────────────

async function handleButton(interaction) {
  const id = interaction.customId;

  // ── Non-shock alarm dismiss/snooze ──
  if (id.startsWith('dismiss_')) {
    const alarmId = parseInt(id.split('_')[1]);
    markDismissed(alarmId);
    stopFiringAlarm(alarmId);
    await interaction.update({ content: '✅ Alarm dismissed.', embeds: [], components: [] });
    return;
  }

  if (id.startsWith('snooze_')) {
    const alarmId = parseInt(id.split('_')[1]);
    const alarm = getAlarm(alarmId);
    const { snooze_count, max_snoozes } = incrementSnooze(alarmId);
    const snoozeMs = 5 * 60;
    rescheduleAlarm(alarmId, Math.floor(Date.now() / 1000) + snoozeMs);
    await interaction.update({ content: `⏱️ Snoozed 5 minutes (${snooze_count}/${max_snoozes} snoozes used).`, embeds: [], components: [] });
    return;
  }

  // ── Lock pair accept/decline ──
  if (id.startsWith('lockpair_accept_')) {
    const [, , wearerId, keyholderId] = id.split('_');
    await lockCmd.handleLockPairAccept(interaction, wearerId, keyholderId);
    return;
  }
  if (id.startsWith('lockpair_decline_')) {
    const [, , wearerId] = id.split('_');
    await lockCmd.handleLockPairDecline(interaction, wearerId);
    return;
  }

  // ── Unlock approve/deny ──
  if (id.startsWith('unlock_approve_')) {
    const requestId = parseInt(id.split('_')[2]);
    await lockCmd.handleUnlockApprove(interaction, requestId);
    return;
  }
  if (id.startsWith('unlock_deny_')) {
    const requestId = parseInt(id.split('_')[2]);
    await lockCmd.handleUnlockDeny(interaction, requestId);
    return;
  }

  await interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

// ── DM message handler — typing test for shock alarms ────────────────────────

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (message.guild) return; // DMs only

  const userId = message.author.id;
  const text = message.content.trim().toLowerCase();

  // Find any alarm currently firing for this user that has a shock + typing test
  // We check all active dismiss challenges for this user
  const { db } = require('./db');
  const challenges = db.prepare(`
    SELECT ad.*, a.user_id, a.shock_enabled, a.shock_intensity, a.shock_duration,
           a.max_snoozes, a.snooze_count, a.id as alarm_id
    FROM alarm_dismiss ad
    JOIN alarms a ON a.id = ad.alarm_id
    WHERE a.user_id = ? AND ad.dismissed_at IS NULL AND a.active = 1
  `).all(userId);

  if (!challenges.length) return;

  for (const challenge of challenges) {
    const alarm = getAlarm(challenge.alarm_id);
    if (!alarm) continue;

    // Check snooze phrase
    if (challenge.snooze_phrase && text === challenge.snooze_phrase.toLowerCase()) {
      const snoozeLeft = alarm.max_snoozes - alarm.snooze_count;
      if (snoozeLeft <= 0) {
        await message.reply(`No snoozes remaining. Type the full dismiss phrase:\n\`\`\`${challenge.phrase}\`\`\``);
        continue;
      }
      const { snooze_count } = incrementSnooze(challenge.alarm_id);
      const newFireAt = Math.floor(Date.now() / 1000) + 5 * 60;
      rescheduleAlarm(challenge.alarm_id, newFireAt);
      stopFiringAlarm(challenge.alarm_id);
      await message.reply(`⏱️ Snoozed 5 minutes (${snooze_count}/${alarm.max_snoozes} snoozes used).`);
      continue;
    }

    // Check dismiss phrase
    if (text === challenge.phrase.toLowerCase()) {
      markDismissed(challenge.alarm_id);
      stopFiringAlarm(challenge.alarm_id);
      await message.reply('✅ Alarm dismissed. Good morning!');
      continue;
    }

    // Wrong answer — penalty shock and new phrase
    if (alarm.shock_enabled && isFiring(challenge.alarm_id)) {
      await penaltyShock(userId, alarm);
    }
    const newPhrase = incrementDismissAttempt(challenge.alarm_id);
    await message.reply(
      `❌ Wrong. ${alarm.shock_enabled ? 'Shock incoming. ' : ''}Type this phrase exactly to dismiss:\n\`\`\`${newPhrase}\`\`\``
    );
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);

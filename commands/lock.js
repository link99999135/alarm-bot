const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DateTime } = require('luxon');
const {
  getLockPairByWearer, getLockPairByKeyholder, getLockPairByEither,
  createLockPair, deleteLockPair, setLocked, setUnlocked,
  extendMinUnlock, setScheduledUnlock,
  createUnlockRequest, updateUnlockRequest, getUser,
} = require('../db');
const lockbox = require('../lockbox');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Manage the lockbox')
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Pair a wearer and keyholder')
      .addUserOption(o => o.setName('wearer').setDescription('The wearer account').setRequired(true))
      .addUserOption(o => o.setName('keyholder').setDescription('The keyholder account').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('lock')
      .setDescription('Lock the box')
      .addStringOption(o => o.setName('min_duration').setDescription('Minimum lock duration e.g. 2h, 30m, 8h').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('unlock')
      .setDescription('Unlock the box (keyholder only)'))
    .addSubcommand(sub => sub
      .setName('request-unlock')
      .setDescription('Request the keyholder to unlock (wearer only)'))
    .addSubcommand(sub => sub
      .setName('schedule')
      .setDescription('Schedule an automatic unlock (keyholder only)')
      .addStringOption(o => o.setName('time').setDescription('Time e.g. 8:00am').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Date e.g. tomorrow, 2024-12-25 (default: today)').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('extend')
      .setDescription('Extend the minimum lock duration (keyholder only)')
      .addStringOption(o => o.setName('duration').setDescription('Amount to extend e.g. 1h, 30m').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Show current lock status'))
    .addSubcommand(sub => sub
      .setName('unpair')
      .setDescription('Remove the pairing (keyholder only)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') await handleSetup(interaction);
    else if (sub === 'lock') await handleLock(interaction);
    else if (sub === 'unlock') await handleUnlock(interaction);
    else if (sub === 'request-unlock') await handleRequestUnlock(interaction);
    else if (sub === 'schedule') await handleSchedule(interaction);
    else if (sub === 'extend') await handleExtend(interaction);
    else if (sub === 'status') await handleStatus(interaction);
    else if (sub === 'unpair') await handleUnpair(interaction);
  },
};

// ── Setup ─────────────────────────────────────────────────────────────────────

async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const wearer = interaction.options.getUser('wearer');
  const keyholder = interaction.options.getUser('keyholder');

  if (wearer.id === keyholder.id) {
    return interaction.editReply('Wearer and keyholder must be different accounts.');
  }

  // Check neither is already paired
  const existingW = getLockPairByWearer(wearer.id);
  if (existingW) {
    return interaction.editReply(`<@${wearer.id}> is already paired. Run \`/lock unpair\` first.`);
  }

  // Send confirmation DM to keyholder
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lockpair_accept_${wearer.id}_${keyholder.id}`).setLabel('Accept — become keyholder').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`lockpair_decline_${wearer.id}_${keyholder.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );
    await keyholder.send({
      content: `<@${wearer.id}> wants to pair you as their **keyholder** for the lockbox bot. You will have exclusive control over locking and unlocking. Do you accept?`,
      components: [row],
    });
    await interaction.editReply(`Pairing request sent to <@${keyholder.id}>. Waiting for them to accept.`);
  } catch {
    await interaction.editReply(`Could not DM <@${keyholder.id}>. They may have DMs disabled.`);
  }
}

// ── Lock ──────────────────────────────────────────────────────────────────────

async function handleLock(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByEither(userId);

  if (!pair) return interaction.editReply('No lockbox pairing found. Run `/lock setup` first.');
  if (pair.is_locked) return interaction.editReply('The box is already locked.');

  const durationStr = interaction.options.getString('min_duration');
  let minUnlockAt = null;

  if (durationStr) {
    const seconds = parseDuration(durationStr);
    if (!seconds) return interaction.editReply('Invalid duration. Use formats like `2h`, `30m`, `1h30m`.');
    minUnlockAt = Math.floor(Date.now() / 1000) + seconds;
  }

  await lockbox.lock();
  setLocked(pair.wearer_id, { minUnlockAt });

  const embed = new EmbedBuilder()
    .setColor(0xE24B4A)
    .setTitle('🔒 Lockbox locked')
    .addFields(
      { name: 'Minimum duration', value: minUnlockAt ? `Until ${DateTime.fromSeconds(minUnlockAt).toFormat('HH:mm dd LLL')}` : 'None set', inline: true },
    );

  await interaction.editReply({ embeds: [embed] });

  // Notify both parties
  try {
    const wearer = await interaction.client.users.fetch(pair.wearer_id);
    const kh = await interaction.client.users.fetch(pair.keyholder_id);
    const msg = `🔒 The lockbox has been locked${minUnlockAt ? ` with a minimum duration until ${DateTime.fromSeconds(minUnlockAt).toFormat('HH:mm dd LLL')}` : ''}.`;
    if (pair.wearer_id !== userId) await wearer.send(msg);
    if (pair.keyholder_id !== userId) await kh.send(msg);
  } catch {}
}

// ── Unlock ────────────────────────────────────────────────────────────────────

async function handleUnlock(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByKeyholder(userId);

  if (!pair) return interaction.editReply('You are not a keyholder in any pairing.');
  if (!pair.is_locked) return interaction.editReply('The box is not currently locked.');

  await lockbox.unlock();
  setUnlocked(pair.wearer_id);

  await interaction.editReply('🔓 Lockbox unlocked.');

  try {
    const wearer = await interaction.client.users.fetch(pair.wearer_id);
    await wearer.send('🔓 Your keyholder has unlocked the lockbox.');
  } catch {}
}

// ── Request unlock ────────────────────────────────────────────────────────────

async function handleRequestUnlock(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByWearer(userId);

  if (!pair) return interaction.editReply('No lockbox pairing found.');
  if (!pair.is_locked) return interaction.editReply('The box is not currently locked.');

  const now = Math.floor(Date.now() / 1000);

  // Check minimum duration
  if (pair.min_unlock_at && pair.min_unlock_at > now) {
    const remaining = pair.min_unlock_at - now;
    const dt = DateTime.fromSeconds(pair.min_unlock_at);
    return interaction.editReply(
      `Your minimum lock duration hasn't elapsed yet. Earliest unlock: **${dt.toFormat('HH:mm dd LLL')}** (${formatDuration(remaining)} remaining).`
    );
  }

  const requestId = createUnlockRequest(userId, pair.keyholder_id);

  try {
    const keyholder = await interaction.client.users.fetch(pair.keyholder_id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`unlock_approve_${requestId}`).setLabel('Approve unlock').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unlock_deny_${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    const msg = await keyholder.send({
      content: `<@${userId}> is requesting to be unlocked. Do you approve?`,
      components: [row],
    });
    updateUnlockRequest(requestId, 'pending', msg.id);
    await interaction.editReply('Unlock request sent to your keyholder. Waiting for their response.');
  } catch {
    await interaction.editReply('Could not DM your keyholder. They may have DMs disabled.');
  }
}

// ── Schedule unlock ───────────────────────────────────────────────────────────

async function handleSchedule(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByKeyholder(userId);

  if (!pair) return interaction.editReply('You are not a keyholder in any pairing.');

  const user = getUser(userId);
  const tz = user.timezone;
  const timeStr = interaction.options.getString('time');
  const dateStr = interaction.options.getString('date') || 'today';

  const now = DateTime.now().setZone(tz);
  let base = dateStr === 'today' ? now : dateStr === 'tomorrow' ? now.plus({ days: 1 }) : DateTime.fromISO(dateStr, { zone: tz });

  const timeParsed = parseTimeString(timeStr, base, tz);
  if (!timeParsed || !timeParsed.isValid) {
    return interaction.editReply('Invalid time. Try `8:00am` or `14:00`.');
  }

  if (timeParsed.toUnixInteger() <= Math.floor(Date.now() / 1000)) {
    return interaction.editReply('That time is in the past.');
  }

  setScheduledUnlock(pair.wearer_id, timeParsed.toUnixInteger());
  await interaction.editReply(`Scheduled unlock set for **${timeParsed.toFormat('HH:mm dd LLL yyyy (ZZZZ)')}**.`);

  try {
    const wearer = await interaction.client.users.fetch(pair.wearer_id);
    await wearer.send(`🔓 Your keyholder has scheduled your unlock for **${timeParsed.toFormat('HH:mm dd LLL yyyy')}**.`);
  } catch {}
}

// ── Extend ────────────────────────────────────────────────────────────────────

async function handleExtend(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByKeyholder(userId);

  if (!pair) return interaction.editReply('You are not a keyholder in any pairing.');
  if (!pair.is_locked) return interaction.editReply('The box is not currently locked.');

  const durationStr = interaction.options.getString('duration');
  const seconds = parseDuration(durationStr);
  if (!seconds) return interaction.editReply('Invalid duration. Use formats like `2h`, `30m`, `1h30m`.');

  const newTime = extendMinUnlock(pair.wearer_id, seconds);
  const dt = DateTime.fromSeconds(newTime);

  await interaction.editReply(`Minimum lock duration extended. New earliest unlock: **${dt.toFormat('HH:mm dd LLL yyyy')}**.`);

  try {
    const wearer = await interaction.client.users.fetch(pair.wearer_id);
    await wearer.send(`Your keyholder has extended your minimum lock duration by ${formatDuration(seconds)}. New earliest unlock: **${dt.toFormat('HH:mm dd LLL yyyy')}**.`);
  } catch {}
}

// ── Status ────────────────────────────────────────────────────────────────────

async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByEither(userId);

  if (!pair) return interaction.editReply('No lockbox pairing found.');

  const now = Math.floor(Date.now() / 1000);
  const embed = new EmbedBuilder()
    .setColor(pair.is_locked ? 0xE24B4A : 0x1D9E75)
    .setTitle(pair.is_locked ? '🔒 Locked' : '🔓 Unlocked')
    .addFields(
      { name: 'Wearer', value: `<@${pair.wearer_id}>`, inline: true },
      { name: 'Keyholder', value: `<@${pair.keyholder_id}>`, inline: true },
    );

  if (pair.is_locked && pair.locked_at) {
    const lockedFor = now - pair.locked_at;
    embed.addFields({ name: 'Locked for', value: formatDuration(lockedFor), inline: true });
  }
  if (pair.min_unlock_at) {
    const remaining = pair.min_unlock_at - now;
    embed.addFields({
      name: 'Minimum duration',
      value: remaining > 0
        ? `${formatDuration(remaining)} remaining (until ${DateTime.fromSeconds(pair.min_unlock_at).toFormat('HH:mm dd LLL')})`
        : 'Elapsed',
      inline: false,
    });
  }
  if (pair.scheduled_unlock_at) {
    embed.addFields({
      name: 'Scheduled unlock',
      value: DateTime.fromSeconds(pair.scheduled_unlock_at).toFormat('HH:mm dd LLL yyyy'),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── Unpair ────────────────────────────────────────────────────────────────────

async function handleUnpair(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const pair = getLockPairByKeyholder(userId);

  if (!pair) return interaction.editReply('You are not a keyholder in any pairing.');
  if (pair.is_locked) return interaction.editReply('Unlock the box before unpairing.');

  deleteLockPair(pair.wearer_id);
  await interaction.editReply('Pairing removed.');

  try {
    const wearer = await interaction.client.users.fetch(pair.wearer_id);
    await wearer.send('Your keyholder has removed the lockbox pairing.');
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDuration(str) {
  let total = 0;
  const h = str.match(/(\d+)h/);
  const m = str.match(/(\d+)m/);
  if (h) total += parseInt(h[1]) * 3600;
  if (m) total += parseInt(m[1]) * 60;
  return total || null;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '<1m';
}

function parseTimeString(str, base, tz) {
  str = str.toLowerCase().trim();
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(str);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2] || '0');
    if (ampm[3] === 'am' && h === 12) h = 0;
    if (ampm[3] === 'pm' && h !== 12) h += 12;
    return base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (h24) return base.set({ hour: parseInt(h24[1]), minute: parseInt(h24[2]), second: 0, millisecond: 0 });
  return null;
}

module.exports.handleLockPairAccept = async function(interaction, wearerId, keyholderId) {
  createLockPair(wearerId, keyholderId);
  await interaction.update({ content: `Pairing confirmed. You are now the keyholder for <@${wearerId}>.`, components: [] });
  try {
    const wearer = await interaction.client.users.fetch(wearerId);
    await wearer.send(`Your keyholder pairing with <@${keyholderId}> has been confirmed. Use \`/lock status\` to check the lockbox.`);
  } catch {}
};

module.exports.handleLockPairDecline = async function(interaction, wearerId) {
  await interaction.update({ content: 'Pairing declined.', components: [] });
  try {
    const wearer = await interaction.client.users.fetch(wearerId);
    await wearer.send('Your keyholder pairing request was declined.');
  } catch {}
};

module.exports.handleUnlockApprove = async function(interaction, requestId) {
  const { getUnlockRequest, updateUnlockRequest, getLockPairByWearer, setUnlocked } = require('../db');
  const req = getUnlockRequest(requestId);
  if (!req || req.status !== 'pending') {
    return interaction.update({ content: 'This request is no longer pending.', components: [] });
  }
  const pair = getLockPairByWearer(req.wearer_id);
  if (!pair || !pair.is_locked) {
    return interaction.update({ content: 'The box is not currently locked.', components: [] });
  }

  await lockbox.unlock();
  setUnlocked(req.wearer_id);
  updateUnlockRequest(requestId, 'approved');
  await interaction.update({ content: `🔓 Unlock approved for <@${req.wearer_id}>.`, components: [] });

  try {
    const wearer = await interaction.client.users.fetch(req.wearer_id);
    await wearer.send('🔓 Your unlock request was approved. The lockbox is open.');
  } catch {}
};

module.exports.handleUnlockDeny = async function(interaction, requestId) {
  const { getUnlockRequest, updateUnlockRequest } = require('../db');
  const req = getUnlockRequest(requestId);
  if (!req || req.status !== 'pending') {
    return interaction.update({ content: 'This request is no longer pending.', components: [] });
  }
  updateUnlockRequest(requestId, 'denied');
  await interaction.update({ content: `Unlock request from <@${req.wearer_id}> denied.`, components: [] });

  try {
    const wearer = await interaction.client.users.fetch(req.wearer_id);
    await wearer.send('Your unlock request was denied by your keyholder.');
  } catch {}
};

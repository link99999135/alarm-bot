const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const {
  createAlarm, getUserAlarms, deleteAlarm, getUser, setUserTimezone,
  getPishockCredentials, getAlarm,
} = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('alarm')
    .setDescription('Manage your alarms')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set a new alarm')
      .addStringOption(o => o.setName('time').setDescription('Time e.g. 7:30am, 14:00').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Date e.g. tomorrow, 2024-12-25 (default: today)').setRequired(false))
      .addStringOption(o => o.setName('label').setDescription('Label for this alarm').setRequired(false))
      .addStringOption(o => o.setName('repeat').setDescription('Repeat: daily, weekdays, weekends').setRequired(false)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekdays (Mon–Fri)', value: 'weekdays' },
          { name: 'Weekends', value: 'weekends' },
        ))
      .addBooleanOption(o => o.setName('shock').setDescription('Trigger PiShock when this alarm fires').setRequired(false))
      .addIntegerOption(o => o.setName('intensity').setDescription('Shock intensity 1–100 (overrides your default)').setMinValue(1).setMaxValue(100).setRequired(false))
      .addIntegerOption(o => o.setName('duration').setDescription('Shock duration in seconds 1–3').setMinValue(1).setMaxValue(3).setRequired(false))
      .addIntegerOption(o => o.setName('max_snoozes').setDescription('Max snoozes before typing test only (default 3)').setMinValue(0).setMaxValue(10).setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List your upcoming alarms'))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete an alarm')
      .addIntegerOption(o => o.setName('id').setDescription('Alarm ID from /alarm list').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('timezone')
      .setDescription('Set your timezone')
      .addStringOption(o => o.setName('zone').setDescription('e.g. Europe/London, America/New_York').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      await handleSet(interaction);
    } else if (sub === 'list') {
      await handleList(interaction);
    } else if (sub === 'delete') {
      await handleDelete(interaction);
    } else if (sub === 'timezone') {
      await handleTimezone(interaction);
    }
  },
};

async function handleSet(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const user = getUser(userId);
  const tz = user.timezone;

  const timeStr = interaction.options.getString('time');
  const dateStr = interaction.options.getString('date') || 'today';
  const label = interaction.options.getString('label');
  const repeat = interaction.options.getString('repeat');
  const shockEnabled = interaction.options.getBoolean('shock') ?? false;
  const intensity = interaction.options.getInteger('intensity');
  const duration = interaction.options.getInteger('duration');
  const maxSnoozes = interaction.options.getInteger('max_snoozes');

  // Parse time
  const now = DateTime.now().setZone(tz);
  let base;
  if (dateStr === 'today') base = now;
  else if (dateStr === 'tomorrow') base = now.plus({ days: 1 });
  else base = DateTime.fromISO(dateStr, { zone: tz });

  if (!base.isValid) {
    return interaction.editReply('Invalid date. Use "today", "tomorrow", or YYYY-MM-DD.');
  }

  // Parse time string (7:30am, 14:00, 7:30)
  const timeParsed = parseTimeString(timeStr, base, tz);
  if (!timeParsed) {
    return interaction.editReply('Invalid time format. Try `7:30am`, `14:00`, or `7:30`.');
  }

  if (timeParsed.toUnixInteger() <= Math.floor(Date.now() / 1000)) {
    return interaction.editReply('That time is in the past. Did you mean tomorrow?');
  }

  if (shockEnabled && !getPishockCredentials(userId)) {
    return interaction.editReply('You need to set up PiShock first — run `/pishock setup`.');
  }

  const alarmId = createAlarm({
    userId,
    channelId: interaction.channelId,
    label,
    fireAt: timeParsed.toUnixInteger(),
    timezone: tz,
    repeatRule: repeat,
    shockEnabled,
    shockIntensity: intensity,
    shockDuration: duration,
    maxSnoozes,
  });

  const embed = new EmbedBuilder()
    .setColor(shockEnabled ? 0xE24B4A : 0x7F77DD)
    .setTitle('Alarm set')
    .addFields(
      { name: 'Time', value: timeParsed.toFormat('cccc, dd LLL yyyy HH:mm (ZZZZ)'), inline: false },
      { name: 'Label', value: label || 'none', inline: true },
      { name: 'Repeat', value: repeat || 'once', inline: true },
      { name: 'PiShock', value: shockEnabled ? `Yes (${['shock','vibrate','beep'][user.default_shock_op]}, ${intensity ?? user.default_shock_intensity}% intensity)` : 'No', inline: true },
      { name: 'ID', value: `#${alarmId}`, inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const user = getUser(userId);
  const alarms = getUserAlarms(userId);

  if (!alarms.length) {
    return interaction.editReply('You have no active alarms.');
  }

  const lines = alarms.map(a => {
    const dt = DateTime.fromSeconds(a.fire_at).setZone(a.timezone);
    const shock = a.shock_enabled ? ' ⚡' : '';
    const repeat = a.repeat_rule ? ` (${a.repeat_rule})` : '';
    return `**#${a.id}** — ${dt.toFormat('dd LLL HH:mm')} ${a.label ? `*${a.label}*` : ''}${shock}${repeat}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x7F77DD)
    .setTitle('Your alarms')
    .setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getInteger('id');
  const result = deleteAlarm(id, interaction.user.id);
  if (result.changes === 0) {
    return interaction.editReply(`No alarm found with ID #${id}.`);
  }
  await interaction.editReply(`Alarm #${id} deleted.`);
}

async function handleTimezone(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const zone = interaction.options.getString('zone');
  const test = DateTime.now().setZone(zone);
  if (!test.isValid) {
    return interaction.editReply(`Invalid timezone \`${zone}\`. Use an IANA name like \`Europe/London\` or \`America/New_York\`.`);
  }
  setUserTimezone(interaction.user.id, zone);
  await interaction.editReply(`Timezone set to **${zone}**. Current time there: ${test.toFormat('HH:mm')}`);
}

function parseTimeString(str, base, tz) {
  str = str.toLowerCase().trim();
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(str);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2] || '0');
    const period = ampm[3];
    if (period === 'am' && h === 12) h = 0;
    if (period === 'pm' && h !== 12) h += 12;
    return base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (h24) {
    return base.set({ hour: parseInt(h24[1]), minute: parseInt(h24[2]), second: 0, millisecond: 0 });
  }
  return null;
}

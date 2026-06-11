const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  savePishockCredentials, getPishockCredentials, setUserShockDefaults, getUser,
} = require('../db');
const pishock = require('../pishock');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pishock')
    .setDescription('Manage your PiShock device')
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Link your PiShock credentials')
      .addStringOption(o => o.setName('username').setDescription('Your PiShock username').setRequired(true))
      .addStringOption(o => o.setName('apikey').setDescription('Your PiShock API key').setRequired(true))
      .addStringOption(o => o.setName('sharecode').setDescription('Your shocker share code').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('test')
      .setDescription('Send a test vibration to confirm your device is connected'))
    .addSubcommand(sub => sub
      .setName('config')
      .setDescription('Set your default shock settings')
      .addStringOption(o => o.setName('mode').setDescription('Default mode').setRequired(false)
        .addChoices(
          { name: 'Shock', value: '0' },
          { name: 'Vibrate', value: '1' },
          { name: 'Beep', value: '2' },
        ))
      .addIntegerOption(o => o.setName('intensity').setDescription('Default intensity 1–100').setMinValue(1).setMaxValue(100).setRequired(false))
      .addIntegerOption(o => o.setName('duration').setDescription('Default duration in seconds 1–3').setMinValue(1).setMaxValue(3).setRequired(false))
      .addIntegerOption(o => o.setName('intensity_cap').setDescription('Hard cap on max intensity (default 50)').setMinValue(1).setMaxValue(100).setRequired(false))
      .addIntegerOption(o => o.setName('max_snoozes').setDescription('Default max snoozes per alarm').setMinValue(0).setMaxValue(10).setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') await handleSetup(interaction);
    else if (sub === 'test') await handleTest(interaction);
    else if (sub === 'config') await handleConfig(interaction);
  },
};

async function handleSetup(interaction) {
  // Ephemeral — credentials never shown in channel
  await interaction.deferReply({ ephemeral: true });
  const username = interaction.options.getString('username');
  const apikey = interaction.options.getString('apikey');
  const sharecode = interaction.options.getString('sharecode');

  savePishockCredentials(interaction.user.id, username, apikey, sharecode);

  await interaction.editReply(
    'PiShock credentials saved and encrypted. Run `/pishock test` to verify your device is responding.'
  );
}

async function handleTest(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const credentials = getPishockCredentials(interaction.user.id);
  if (!credentials) {
    return interaction.editReply('No PiShock credentials found. Run `/pishock setup` first.');
  }

  const result = await pishock.test(credentials);
  if (result.ok) {
    await interaction.editReply('Test vibration sent! If your device buzzed, everything is working.');
  } else {
    await interaction.editReply(`PiShock responded with an error: \`${result.body || result.error}\`\nDouble-check your credentials with \`/pishock setup\`.`);
  }
}

async function handleConfig(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  const mode = interaction.options.getString('mode');
  const intensity = interaction.options.getInteger('intensity');
  const duration = interaction.options.getInteger('duration');
  const intensityCap = interaction.options.getInteger('intensity_cap');
  const maxSnoozes = interaction.options.getInteger('max_snoozes');

  if (!mode && !intensity && !duration && !intensityCap && !maxSnoozes) {
    const user = getUser(userId);
    return interaction.editReply(
      `Current defaults:\nMode: **${['Shock','Vibrate','Beep'][user.default_shock_op]}** | Intensity: **${user.default_shock_intensity}%** | Duration: **${user.default_shock_duration}s** | Cap: **${user.shock_intensity_cap}%** | Max snoozes: **${user.default_max_snoozes}**`
    );
  }

  setUserShockDefaults(userId, {
    op: mode !== null ? parseInt(mode) : undefined,
    intensity,
    duration,
    maxSnoozes,
    intensityCap,
  });

  await interaction.editReply('Default PiShock settings updated.');
}

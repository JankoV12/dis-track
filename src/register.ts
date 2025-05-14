import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong!'),

    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a YouTube or Spotify track')
        .addStringOption(opt =>
            opt.setName('url')
               .setDescription('YouTube/Spotify URL')
               .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pause the current playback'),

    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume playback if paused'),

    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current track'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop playback and clear the queue'),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Disconnect the bot from the voice channel')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

(async () => {
    try {
        console.log('⏳  Registering slash commands…');
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID!,
                process.env.GUILD_ID!
            ),
            { body: commands }
        );
        console.log('✅  Slash commands registered!');
    } catch (err) {
        console.error(err);
    }
})();

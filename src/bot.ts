import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import playdl from 'play-dl';
import ytdl from '@distube/ytdl-core';

// Try to authorise Spotify access for play‑dl
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    playdl.setToken({
        spotify: {
            client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN ?? undefined,
            market: 'US'
        }
    });
    console.log(`🎧  Spotify credentials loaded – ${process.env.SPOTIFY_REFRESH_TOKEN ? 'full track/playlist support' : 'client‑credentials only (public tracks)'}.`);
    if (!process.env.SPOTIFY_REFRESH_TOKEN) {
        console.warn('⚠️  SPOTIFY_REFRESH_TOKEN is not set. Some private/large Spotify endpoints may fail. See README for token generation.');
    }
} else {
    console.warn('⚠️  Spotify credentials missing (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET). Spotify links will fail.');
}

const queues: Map<string, string[]> = new Map();

/**
 * Resolve the given URL into one or more playable YouTube links.
 *  - YouTube links are returned as‑is.
 *  - Spotify links are mapped to YouTube via play‑dl search.
 */
async function resolveTracks(url: string): Promise<string[]> {
    // ─── YouTube playlist ──────────────────────────────────────
    // any link that contains a "list=" parameter is considered a playlist
    if (/youtube\.com\/.*[?&]list=/.test(url)) {
        try {
            const pl = await playdl.playlist_info(url, { incomplete: true });
            // pull every video URL in order
            const vids = await pl.all_videos();
            return vids.map(v => v.url);
        } catch (err) {
            console.error('YouTube playlist resolve error:', err);
            return [];
        }
    }

    // ─── Single YouTube video ──────────────────────────────────
    if (/youtu\.?be|youtube\.com/.test(url)) return [url];

    // Spotify handling
    if (/open\.spotify\.com/.test(url)) {
        try {
            const sp = await playdl.spotify(url);
            // Single track
            if (sp.type === 'track') {
                const search = await playdl.search(`${sp.name} ${sp.artists[0].name}`, { limit: 1 });
                return search.length ? [search[0].url] : [];
            }
            // Playlist / Album
            if (sp.type === 'playlist' || sp.type === 'album') {
                const all = await sp.all_tracks();
                const tracks: string[] = [];
                for (const t of all) {
                    const sr = await playdl.search(`${t.name} ${t.artists[0].name}`, { limit: 1 });
                    if (sr.length) tracks.push(sr[0].url);
                }
                return tracks;
            }
        } catch (err) {
            console.error('Spotify resolve error:', err);
        }
        return [];
    }

    // Fallback – treat as single generic link (play‑dl will attempt streaming)
    return [url];
}

async function createResource(url: string) {
    if (/youtu\.?be/.test(url)) {
        const ytStream = ytdl(url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
        });
        return createAudioResource(ytStream, { inputType: StreamType.Arbitrary });
    } else {
        const stream = await playdl.stream(url, { quality: 2 });
        return createAudioResource(stream.stream, {
            inputType: stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary
        });
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,          // required for slash‑command interactions
        GatewayIntentBits.GuildMessages,   // read messages (for prefix cmds)
        GatewayIntentBits.GuildVoiceStates, // track users' voice‑channel presence
        GatewayIntentBits.MessageContent   // read message content (privileged intent)
    ]
});

const player = createAudioPlayer();

// Destroy the connection when the player becomes idle.
player.on(AudioPlayerStatus.Idle, () => {
    const connection = player.subscribers.find(sub => sub.connection)?.connection;
    if (!connection) return;

    const guildId = connection.joinConfig.guildId;
    const q = queues.get(guildId);

    if (q && q.length) {
        const nextUrl = q.shift()!;
        (async () => {
            try {
                const resource = await createResource(nextUrl);
                player.play(resource);
            } catch (err) {
                console.error(err);
                connection.destroy();
            }
        })();
    } else {
        connection.destroy();
    }
});

client.once(Events.ClientReady, c => {
    console.log(`✅  Logged in as ${c.user.tag}`);
});

// simple prefix command
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.content === '!ping') {
        await message.reply('Pong! 🏓');
    }
    else if (message.content.startsWith('!play')) {
        // Strip the prefix and any leading whitespace to get the raw URL/string
        const url = message.content.replace(/^!play\s+/i, '').trim();
        if (!url) {
            await message.reply('❌ Usage: `!play <YouTube/Spotify URL>`');
            return;
        }
        const voiceChannel = message.member?.voice.channel;

        if (!voiceChannel) {
            await message.reply('❌ You need to join a voice channel first.');
            return;
        }

        try {
            const tracks = await resolveTracks(url);
            if (!tracks.length) {
                await message.reply('⚠️  Couldn\'t resolve that link to a playable track.');
                return;
            }

            const guildId = voiceChannel.guild.id;
            let q = queues.get(guildId);
            if (!q) { q = []; queues.set(guildId, q); }

            // If nothing is playing and queue is empty, start the first track immediately
            if (player.state.status === AudioPlayerStatus.Idle && q.length === 0) {
                const first = tracks.shift()!;
                const resource = await createResource(first);

                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator
                });

                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                connection.subscribe(player);
                player.play(resource);

                if (tracks.length) q.push(...tracks);
                await message.reply(`🎶 Now playing: ${first}${tracks.length ? ` (+${tracks.length} more in queue)` : ''}`);
            } else {
                q.push(...tracks);
                await message.reply(`📥 Added ${tracks.length} track${tracks.length > 1 ? 's' : ''} to queue (#${q.length})`);
            }
        } catch (err) {
            console.error(err);
            await message.reply('⚠️  I couldn\'t play that track.');
        }
    }
    else if (message.content === '!pause') {
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await message.reply('⏸️ Paused.');
        } else {
            await message.reply('⚠️ Nothing is currently playing.');
        }
    }
    else if (message.content === '!resume') {
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await message.reply('▶️ Resumed.');
        } else {
            await message.reply('⚠️ Nothing is paused.');
        }
    }
    else if (message.content === '!skip') {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await message.reply('⏭️ Skipped.');
        } else {
            await message.reply('⚠️ Nothing to skip.');
        }
    }
    else if (message.content === '!stop') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await message.reply('⏹️ Stopped playback and cleared queue.');
        } else {
            await message.reply('⚠️ I\'m not in a voice channel.');
        }
    }
    else if (message.content === '!leave') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await message.reply('👋 Left the voice channel.');
        } else {
            await message.reply('⚠️ I\'m not in a voice channel.');
        }
    }
});

// slash‑command handler
client.on(Events.InteractionCreate, async interaction  => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong! 🏓');
    }
    else if (interaction.commandName === 'play') {
        const url = interaction.options.getString('url', true);

        if (!interaction.member || !('voice' in interaction.member) || !interaction.member.voice.channel) {
            await interaction.reply({ content: '❌ You need to join a voice channel first.', ephemeral: true });
            return;
        }
        const voiceChannel = interaction.member.voice.channel;

        try {
            const tracks = await resolveTracks(url);
            if (!tracks.length) {
                await interaction.reply({ content: '⚠️  Couldn\'t resolve that link to a playable track.', ephemeral: true });
                return;
            }

            const guildId = voiceChannel.guild.id;
            let q = queues.get(guildId);
            if (!q) { q = []; queues.set(guildId, q); }

            if (player.state.status === AudioPlayerStatus.Idle && q.length === 0) {
                const first = tracks.shift()!;
                const resource = await createResource(first);

                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator
                });

                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                connection.subscribe(player);
                player.play(resource);

                if (tracks.length) q.push(...tracks);
                await interaction.reply(`🎶 Now playing: ${first}${tracks.length ? ` (+${tracks.length} more in queue)` : ''}`);
            } else {
                q.push(...tracks);
                await interaction.reply(`📥 Added ${tracks.length} track${tracks.length > 1 ? 's' : ''} to queue (#${q.length})`);
            }
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: '⚠️  I couldn\'t play that track.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'pause') {
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            await interaction.reply('⏸️ Paused.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is currently playing.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'resume') {
        if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            await interaction.reply('▶️ Resumed.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing is paused.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'skip') {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
            await interaction.reply('⏭️ Skipped.');
        } else {
            await interaction.reply({ content: '⚠️ Nothing to skip.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'stop') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await interaction.reply('⏹️ Stopped playback and cleared queue.');
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
    else if (interaction.commandName === 'leave') {
        const connection = player.subscribers.find(sub => sub.connection)?.connection;
        if (connection) {
            queues.set(connection.joinConfig.guildId, []);
            player.stop();
            connection.destroy();
            await interaction.reply('👋 Left the voice channel.');
        } else {
            await interaction.reply({ content: '⚠️ I\'m not in a voice channel.', ephemeral: true });
        }
    }
});

void client.login(process.env.DISCORD_TOKEN);

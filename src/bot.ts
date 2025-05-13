import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,          // required for slash‑command interactions
        GatewayIntentBits.GuildMessages,   // read messages (for prefix cmds)
        GatewayIntentBits.MessageContent   // read message content (privileged intent)
    ]
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
});

// slash‑command handler
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong! 🏓');
    }
});

void client.login(process.env.DISCORD_TOKEN);

# dis-track

## API Endpoints

- `POST /api/login` – Exchange a Discord OAuth2 code for tokens. Requires `code` and `redirectUri` in the request body.
- `GET /api/bot/guilds` – Returns guilds the bot is in. Requires the bot token via environment variable.

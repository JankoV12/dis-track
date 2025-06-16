# dis-track

## API Endpoints

- `POST /api/login` – Exchange a Discord OAuth2 code for tokens. Requires `code` and `redirectUri` in the request body.
- `GET /api/bot/guilds` – Returns guilds the bot is in. Requires the bot token via environment variable.

## Docker Compose

1. Copy `.env.example` to `.env` and fill in your Discord and Spotify credentials.
2. Run `docker-compose up --build` to build and start the API server.

The API will be available on the port specified in `API_PORT` (defaults to 3000).

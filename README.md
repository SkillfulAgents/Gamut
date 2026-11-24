<p align="center">
  <img src="build/icon.png" height="128">
  <h1 align="center">Gamut</h1>
</p>

Gamut is an open-source platform for building and running AI agents. Each agent runs in its own sandboxed container, connects to your accounts without ever seeing their tokens, learns skills as it works, and can keep working on a schedule in the background.

Documentation: **[gamut.so/docs](https://gamut.so/docs)**

## Ways to run Gamut

| | What it is | Get started |
|---|---|---|
| **Cloud** | Gamut hosts everything. Nothing to install. | [Sign up](https://platform.gamutagents.com/auth/login?mode=signup) at [gamut.so](https://gamut.so) |
| **Desktop** | The app runs every agent locally on your computer, and can also connect to your Cloud workspace. macOS 13 or later on Apple Silicon, and Windows (x64 and arm64). | [Download for Mac](https://updates.gamut.so/download/mac) · [Mac App Store](https://apps.apple.com/us/app/gamut-agentic-os-for-teams/id6801340586) · [Download for Windows](https://updates.gamut.so/download/win) · [Docs](https://gamut.so/docs/self-hosting/deployment-options/electron-desktop-app) |
| **Self-hosted** | You run the server on your own hardware with Docker, or on Kubernetes. | [Quick start](#self-hosting-with-docker) below |

## Features

- **Sandboxed agents**: every agent gets its own container.
- **Connected accounts**: API calls go through a proxy outside the agent, so the agent never sees your auth tokens and every call is logged.
- **Scheduled and recurring tasks**: agents schedule their own future and repeating work.
- **Browser use**: agents can drive a web browser where no API or MCP server exists.
- **Dashboards, artifacts and widgets**: agents build views of your information.
- **Skills and skillsets**: agents write skills as they work, and you can share them with your team as skillsets.
- **Chat integrations**: talk to agents from Slack, Telegram or iMessage.

## Models

Gamut is not tied to one model vendor. Add connections in **Settings > Model Providers**:

- **Anthropic API** and **AWS Bedrock**
- **OpenRouter**
- **Subscriptions**: Claude, Codex (ChatGPT), Grok, Kimi, MiniMax and Qwen
- **Ollama**, for open models on your own hardware
- **Generic**: any Anthropic- or OpenAI-compatible endpoint at a base URL (OpenAI, vLLM, LiteLLM and similar)

On Cloud, models come with your plan.

## Self-hosting with Docker

You need Docker Engine (or Docker Desktop) with Docker Compose v2. The Gamut container starts each agent as a sibling container through the host's Docker socket.

```bash
git clone https://github.com/SkillfulAgents/Gamut.git
cd Gamut
docker compose up
```

Open http://localhost:47891 and add a model provider in **Settings > Model Providers**. To start with an Anthropic key instead, run `ANTHROPIC_API_KEY=sk-ant-... docker compose up`.

The compose file uses the published image `ghcr.io/skillfulagents/superagent:main` and keeps data in `~/.superagent` on the host. Images are built for `linux/amd64` and `linux/arm64`:

| Tag | Description |
|---|---|
| `main` | Latest build from `main` (single-user) |
| `main-auth` | Latest build from `main` with sign-in (multi-user) |
| `X.Y.Z`, `X.Y` | Release versions (single-user) |
| `X.Y.Z-auth`, `X.Y-auth` | Release versions with sign-in (multi-user) |

Single-user mode has no login screen, so restrict access at the network level. For a multi-user server with sign-in:

```bash
SUPERAGENT_IMAGE=ghcr.io/skillfulagents/superagent:main-auth \
TRUSTED_ORIGINS=https://gamut.example.com \
docker compose up
```

To build the image from source instead, run `docker compose up --build` (add `AUTH_MODE=true` for a multi-user build).

More in the docs:

- [Single-user Docker](https://gamut.so/docs/self-hosting/deployment-options/single-user-docker)
- [Auth mode (multi-user)](https://gamut.so/docs/self-hosting/deployment-options/auth-mode)
- [Kubernetes with Helm](https://gamut.so/docs/self-hosting/deployment-options/kubernetes-helm)
- [Desktop app](https://gamut.so/docs/self-hosting/deployment-options/electron-desktop-app)

## Development

Requirements: Node.js 22.12 or later, and a container runtime (Docker or Podman) for the agent containers.

```bash
npm install
npm run dev            # web app and API on http://localhost:47891
npm run dev:electron   # or the desktop app
```

The database is migrated when the server starts. Configuration such as `ANTHROPIC_API_KEY` can go in `.env.local` (see `.env.local.example`), or be set in the app.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the API built in (port 47891, or `PORT`) |
| `npm run dev:api` | API server only, with reload (`src/web/server.ts`) |
| `npm run dev:electron` | Electron app in development |
| `npm run build` | Production build of the web app and API |
| `npm run preview` | Build, then run the production server locally |
| `npm run build:electron` | Build the Electron app |
| `npm run build:container` | Build the agent container image locally (`superagent-container`) |
| `npm run dist:mac` / `dist:win` | Package the desktop app for macOS / Windows |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | ESLint |
| `npm test` / `npm run test:run` | Unit tests (watch / once); `test:coverage` adds coverage |
| `npm run test:e2e` | Playwright end-to-end tests against mocks |
| `npm run db:generate` | Generate a migration and bundle it |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Open Drizzle Studio |

Before changing code, read [AGENTS.md](AGENTS.md): it holds the project's rules (database access, background work, capability gating and more), with links to the design docs in [`docs/`](docs/). Release steps are in [release.md](release.md).

### On-demand PR desktop builds

To build signed macOS and Windows installers for a PR, open **Actions → PR Build → Run workflow** on `main` and enter the PR number, or run:

```sh
gh workflow run pr-build.yml --ref main -f pr_number=1477
```

Both platforms build the PR's current head commit, and the workflow posts artifact links (kept 14 days) in a PR comment. Signed builds need the PR branch to be in this repository. Add `-f mas=true` (or tick **Also build the Mac App Store package**) to also build the Mac App Store package, which App Store Connect validates and nothing uploads. PR pushes run tests only; `main` pushes and version tags still build automatically.

## License

[MIT](LICENSE)

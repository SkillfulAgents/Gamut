# Run SuperAgent on Cloudflare

One Cloudflare Worker serves one org: the UI, the API, the database (D1), the files (R2), and one
container per agent. The entry point is `src/cf`; `src/cf/wrangler.jsonc` is its configuration.

## What you need

- A Cloudflare account on the Workers Paid plan, because Cloudflare Containers are not on the Free plan (Workers for Platforms is not needed), with R2 enabled: the deploy creates R2 buckets and fails without it.
- Node 22 and this repository with `npm ci` done.
- Docker running: the deploy builds the agent image from `agent-container/Dockerfile`, adds the Cloudflare layer (`src/cf/container/Dockerfile`), and pushes it to Cloudflare. The image is `linux/amd64`, so on Apple silicon Docker builds it under emulation. The first deploy takes about ten minutes; later deploys reuse the cached layers and take a minute or two.

## Name the deployment

The Worker's name is `name` in `wrangler.jsonc` (`superagent`), and the deploy names the D1
database and the R2 buckets after it (`superagent-db`, `superagent-host-files`,
`superagent-workspaces`). The container application has a name of its own, `containers[0].name`
(`superagent-agent`), which does not follow the Worker's. To run more than one org in one
Cloudflare account, change both names in each copy of `wrangler.jsonc`.

## Deploy

```sh
npx wrangler login
npx wrangler secret put SUPERAGENT_VAULT_KEY --config src/cf/wrangler.jsonc   # paste: openssl rand -base64 32
npx wrangler secret put BETTER_AUTH_SECRET --config src/cf/wrangler.jsonc     # paste: openssl rand -base64 32
npm run deploy:cf
```

`wrangler secret put` offers to create the Worker when it does not exist yet; accept. The first
deploy creates the D1 database and the R2 buckets; later deploys find them again by the Worker's
and the bindings' names, so `wrangler.jsonc` needs no ids and the deploy writes none back.

Open the URL the deploy prints. The first request migrates the database, which takes a few
seconds; a request that arrives before it is done fails (the page shows "Internal server error"),
so reload once. The first person who signs up becomes the admin, so sign up right after the first
deploy, before you share the URL. After that, sign-up is by invitation: an admin adds people in
Settings → Users, and each gets a temporary password to change at first sign-in.

Keep `SUPERAGENT_VAULT_KEY`: saved browser logins are sealed with it, and a Worker cannot make a new one.

## Model provider

After sign-up, the setup wizard asks for a model provider key (Anthropic, OpenRouter or Amazon
Bedrock) and saves it in the database. To keep the key out of the browser, set it as a secret
before you open the wizard; the wizard then shows "Using environment variable":

```sh
npx wrangler secret put ANTHROPIC_API_KEY --config src/cf/wrangler.jsonc
```

A Worker you deploy yourself does not sign in with a Gamut account: that is for deployments
Gamut Platform manages (`PLATFORM_TOKEN` below). So what Gamut Platform provides is not offered
there, such as Gamut models, connected accounts through Platform, Gamut drives and webhook triggers.

## Update

Pull, then `npm run deploy:cf` again. The new code migrates the database when it first runs, and
each Durable Object restarts on the new code when a request reaches it. A running agent keeps its
container through the deploy.

## Options

| Name | Kind | What it does |
| --- | --- | --- |
| `APP_ORIGIN` | variable | The origin browsers use, for example `https://agents.example.com`. Set it when you serve the Worker on your own domain. Unset, the origin of the first request to a deploy is trusted for sign-in. |
| `STORAGE_LOCATION` | variable | Where the database is, as Cloudflare's location hint, for example `wnam`. New Durable Objects are made near it. Unset: each is made near its first caller. |
| `SEED_SETTINGS` | variable | Settings a new org starts from, as JSON. Applied once. |
| `AGENT_INSTANCE_TYPE` | variable | The instance type of each agent's container, which sets its CPU and memory. Unset: `standard-3` (2 vCPU, 8 GiB). The CPU and memory limits in Settings → Container Runtime do not apply on Cloudflare. |
| `CONTAINER_SNAPSHOT` | variable | A container snapshot agents start from, as JSON (`id`, `name`, `size`). Unset: the image. |
| `HOST_PUBLIC_URL` | variable | The public URL meeting providers call back, for example `https://agents.example.com`. Without it, meetings are not offered. |
| `ANTHROPIC_API_KEY` | secret | A model provider key the wizard and Settings use as "Using environment variable" (see Model provider). |
| `DEPLOY_TOKEN` | secret | Lets a deploy script call `POST /_deploy/prepare` with `Authorization: Bearer <token>` right after an upload, so the database is migrated before the new code serves a request. The call answers 503 while Cloudflare still runs the previous code; call it again. |
| `AUTH_PROVIDERS_JSON`, `PLATFORM_TOKEN` | secrets | Only for a deployment that Gamut Platform manages. |

Wrangler serves the Worker on its `workers.dev` address and turns on Preview URLs (a public URL
for each uploaded version) unless `wrangler.jsonc` turns them off. To serve only on your own
domain, add `"workers_dev": false` and `"preview_urls": false`, route the domain to the Worker,
and set `APP_ORIGIN`.

The Worker uses Smart Placement (`placement` in `wrangler.jsonc`): once Cloudflare has seen enough of its traffic, it runs the Worker near the database, not near each visitor.

## Cost

- The org's task manager object stays awake, because it holds the chat and webhook connections.
- Each running agent is one container; an agent that is idle past the auto-sleep time in Settings stops, and its files stay in R2.

## Remove a deployment

Deleting the Worker removes its Durable Objects and what they hold, but not the database, the
buckets, the container application or its image. Remove each by name; all but the container
application start with the Worker's name:

```sh
npx wrangler containers list                    # the id of the container application (superagent-agent)
npx wrangler containers delete <id>
npx wrangler delete --name superagent
npx wrangler containers images list             # superagent-agentdurableobject-agent, one tag per deploy
npx wrangler containers images delete superagent-agentdurableobject-agent:<tag>
npx wrangler r2 bucket delete superagent-workspaces
npx wrangler r2 bucket delete superagent-host-files
npx wrangler d1 delete superagent-db
```

R2 deletes only an empty bucket, and Wrangler deletes objects one at a time, so empty a bucket
with many objects another way first, for example with an S3-compatible client (`rclone purge`).
Run outside a terminal, Wrangler answers its own confirmation prompts with yes, so check every
name before you run these from a script.

## Limits

- The Worker runs in auth mode; local-mode sign-in does not work on Cloudflare.
- Features that reach the computer the app runs on are not offered: computer use, the host's Chrome, local folders, host git and host scripts. Agents browse in the built-in browser inside their container.
- A change to the auto-sleep time applies at each agent's next idle check, which can be as late as the previous auto-sleep time.
- More are listed under "Known limits" in the pull requests that added `src/cf` (SUP-1408).

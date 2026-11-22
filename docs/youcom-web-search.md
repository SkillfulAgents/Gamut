# You.com web search

Choose **Settings → Web → You.com** and start a new agent session. Gamut uses
You.com for web search and the model’s built-in page reader where available.

Without a key, the host uses `https://api.you.com/mcp/free` for up to 100
searches per day. Add a key in Settings or set `YDC_API_KEY` to use your
You.com account’s billing and rate limits at `https://api.you.com/mcp`.
Saving a key runs a one-result search to verify search access. A saved key
takes precedence over the environment variable.

The selection is saved as `webProvider: "youcom"`. With no selection, the
default is Gamut for signed-in users and Native otherwise.

The host sends search queries and supported filters to You.com with the
standard Gamut User-Agent. It uses highlights as excerpts, caps the result
count, and enforces the requested domains and the operator’s site policy on
returned links. A requested domain includes its subdomains. News publication
times are checked against the requested date range. Results without a known
publication time are kept. Web index dates are not publication times.

[You.com MCP documentation](https://you.com/docs/agents/mcp-server) ·
[You.com privacy policy](https://you.com/privacy)

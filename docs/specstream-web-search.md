# SpecStream web search

Choose **Settings → Web → SpecStream**, add a SpecStream API key, and start a
new agent session. Gamut then uses SpecStream for both web search and page
reading, with every model.

Search calls `GET https://api.specstream.ai/v1/web-search` and page reading
calls `POST https://api.specstream.ai/v1/extract`, both with the key as a
Bearer token. Set the key in Settings or as `SPECSTREAM_API_KEY`; a saved key
takes precedence over the environment variable. Saving a key sends one search
with no query, which the API refuses before running or billing it, so the
check is free. Keys are created at https://specstream.ai/workspace/keys.

The selection is saved as `webProvider: "specstream"`. It is never chosen
automatically: with no selection, the default stays Gamut for signed-in users
and Native otherwise.

Requested domains travel in the query as `site:` operators, so the search runs
inside those sites, and a requested domain includes its subdomains. The host
also enforces the requested domains, the operator's site policy and the
requested publication dates on returned links. Results without a stated
publication date are kept.

Page reading returns the page's main text as markdown, and also reads PDF,
Word and Excel links. Only a live read counts: a page the API could not read,
or could serve only from an archived copy, is reported as a failed fetch.

A search of up to 10 results costs $0.005 and a page read $0.0008, from the
SpecStream account the key belongs to.

[SpecStream API reference](https://specstream.ai/agents.md) ·
[SpecStream privacy policy](https://specstream.ai/privacy)

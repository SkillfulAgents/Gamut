[TEST_PASS]
[REASON] Browser-use smoke test: open the agent, ask it to open example.com and report the page title, and verify the reply says "Example Domain".
[STEP] Step 1, navigated to http://localhost:47891 — Gamut home loaded with the sidebar listing agents QA-20261123-224253-x53l and QA-20261123-224252-zjzx. No errors.
[STEP] Step 2, clicked the QA-20261123-224253-x53l agent in the sidebar — agent session view opened at /agents/qa-20261123-224253-x53l-70jdejr6zw with an empty message composer.
[STEP] Step 3, typed "Open a browser and go to https://example.com. Tell me the page title." and clicked Send — message appeared in the chat, the session switched to "Working..." and the sidebar showed the new session "Check Example.com Page Title" as working.
[STEP] Step 4, waited for the response (wait-for on "Example Domain", 180s limit) — the text appeared and the agent went idle. It finished in about 3s with 2 tool calls.
[STEP] Step 5, verified the response and took a screenshot — the reply reads 'The page title is "Example Domain". The browser is still open on https://example.com if you want to do anything else there.' The live browser preview panel opened on the right showing the example.com page, with an "Open Browser https://example.com" action listed under "Browser agent actions".

Observations (not counted as bugs):
- During the run the chat showed a "ToolSearch" tool-call card with a search bar. It is an internal tool name exposed in the UI, which may be unintended.
- The browser tool calls were collapsed under "Worked for 3s · 2 tool calls", so the individual browser_open/browser_snapshot cards were not visible without expanding.

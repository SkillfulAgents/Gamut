[TEST_PASS]
[REASON] Opened the QA-20261123-205334-84sr agent, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing both QA agents, both idle.
[STEP] Clicked the QA-20261123-205334-84sr agent in the sidebar — its agent page opened at /agents/qa-20261123-205334-84sr-r55fnsuw46.
[STEP] Checked the agent status — the header status indicator reads "idle", which is an allowed status.
[STEP] Typed "Hello! What is 2+2?" into the message box and clicked Send — the message was sent and the page navigated to a new session titled "Basic Arithmetic Greeting".
[STEP] Waited for a response — "2 + 2 = 4." appeared right away, well within the 3-minute limit. The activity indicator was no longer showing.
[STEP] Verified the response mentions "4" and took a screenshot — the chat shows the user message "Hello! What is 2+2?" followed by the assistant reply "2 + 2 = 4.", and the agent is still idle.

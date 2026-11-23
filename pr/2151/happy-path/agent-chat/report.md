[TEST_PASS]
[REASON] Opened the QA-20261123-210100-yvg3 agent, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] 1. Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing both QA-20261123-210101-sh5a and QA-20261123-210100-yvg3.
[STEP] 2. Clicked QA-20261123-210100-yvg3 in the sidebar — the URL changed to /agents/qa-20261123-210100-yvg3-s61x3rsxqu and the agent page opened. Screenshot: step2-agent-selected.png.
[STEP] 3. Verified agent status — the status indicator in the top-right shows "idle", which satisfies the running-or-idle requirement.
[STEP] 4. Sent "Hello! What is 2+2?" — typed into the message box and clicked Send. The app navigated to a new session, and the user message appeared in the message list.
[STEP] 5. Waited for a response — the assistant reply "2 + 2 = 4." appeared within the wait window, with no timeout.
[STEP] 6. Verified the response mentions "4" — "2 + 2 = 4." is shown in the message list. Screenshot taken: step6-response.png.

Observation, not a confirmed bug: the chat header still reads "New Session" while the sidebar lists the session as "Basic Arithmetic Question Check". This may be a title-refresh timing issue, but I did not re-check it after a reload.

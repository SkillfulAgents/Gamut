[TEST_PASS]
[REASON] Opened agent QA-20261121-202406-m76p, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut app loaded and the sidebar listed QA-20261121-202407-g43t and QA-20261121-202406-m76p, both idle.
[STEP] Step 2: Clicked QA-20261121-202406-m76p in the sidebar — the agent page opened at /agents/qa-20261121-202406-m76p-2v4xi3b1yw with its name in the header.
[STEP] Step 3: Checked the agent status — the header shows "idle" and the sidebar shows the agent as idle, so the "running or idle" requirement is met.
[STEP] Step 4: Typed "Hello! What is 2+2?" into the message input and clicked the send button — the message was submitted and the view moved to a new session (New Session).
[STEP] Step 5: Waited for a response — the reply "2 + 2 = 4." appeared in the message list almost immediately, so no wait beyond the first check was needed.
[STEP] Step 6: Verified the response mentions "4" — it reads "2 + 2 = 4.", and the screenshot shows the user message followed by the assistant reply in the chat view.

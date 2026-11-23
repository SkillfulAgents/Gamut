[TEST_PASS]
[REASON] Opened the QA-20261123-202412-v69a agent, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut app loaded with the sidebar listing "QA-20261123-202412-v69a" (idle).
[STEP] Step 2: Clicked "QA-20261123-202412-v69a" in the sidebar — the agent page opened at /agents/qa-20261123-202412-v69a-d6zkhlspey.
[STEP] Step 3: Checked the agent status indicator — it reads "idle", which is an allowed status.
[STEP] Step 4: Typed "Hello! What is 2+2?" into the message input and clicked Send — the message appeared in the conversation and a new session opened.
[STEP] Step 5: Waited for the response — the activity indicator showed "Working..." briefly, then the agent finished and returned to idle. An early streamed fragment showed only "2" while still working; the final reply was "2 + 2 = 4."
[STEP] Step 6: Verified the reply contains "4" — it does ("2 + 2 = 4."). Screenshot taken showing the user message and the reply.

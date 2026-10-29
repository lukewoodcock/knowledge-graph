# Running the demo from cold

Everything from a machine with nothing running to the end of the demo, in
order. The talking points and the rehearsal timings are in
[SCRIPT.md](SCRIPT.md); this page is the commands. The
[diagram in SCRIPT.md](SCRIPT.md#demo-script) shows the demo at a glance.

It runs natively, as every rehearsal did: the Ollama app on the Mac's GPU, and
the knowledge-graph service from `demo/service.sh` in its own terminal. Podman isn't
used: a container on macOS can't reach the GPU.

The repository is `~/Personal/knowledge-graph`, and the demo lives in
`~/knowledge-graph-demo`.

## Part 1: once, before the day (about 20 minutes)

### 1.1 Install Obsidian

```bash
brew install --cask obsidian
```

### 1.2 Check out the demo branch and build it

Until PR #17 is merged, the demo kit is on `poc-loop`.

```bash
cd ~/Personal/knowledge-graph
git switch poc-loop
git pull
npm ci
npm run build
```

Done when `ls dist/hook` lists `prompt.js` and `stop.js`.

### 1.3 Start Ollama and check the models

```bash
open -a Ollama
curl -s localhost:11434/api/tags | grep -oE '"(qwen3.5:9b|bge-large:latest|qwen3.6:35b-a3b-coding)"'
```

Done when all three model names print. If one is missing:
`ollama pull qwen3.5:9b`, `ollama pull bge-large` or
`ollama pull qwen3.6:35b-a3b-coding` (the Reader's model for step 5, 22 GB).

### 1.4 Create the demo projects and vault

```bash
cd ~/Personal/knowledge-graph
demo/setup.sh ~/knowledge-graph-demo
```

This makes `~/knowledge-graph-demo/shortlinks` (project A),
`~/knowledge-graph-demo/notes-api` (project B), `~/knowledge-graph-demo/vault` and
`~/knowledge-graph-demo/demo.env`. It ends with `setup: done.`

### 1.5 Start the service

In a new terminal, which becomes the **service terminal**:

```bash
cd ~/Personal/knowledge-graph
source ~/knowledge-graph-demo/demo.env
demo/service.sh "$DEMO_VAULT" 5678
```

Done when it prints `knowledge-graph listening on 127.0.0.1:5678` and
`index: 13 notes, ...`. Leave it running.

### 1.6 Trust both projects

Claude Code ignores a project's settings until you trust the folder. In
another terminal:

```bash
source ~/knowledge-graph-demo/demo.env
~/Personal/knowledge-graph/demo/injection.sh "$DEMO_B" on
cd "$DEMO_A" && claude
```

1. Accept the trust dialog ("Yes, proceed"). Approve the `knowledge-graph` MCP server
   if asked.
2. Type `/mcp`: `knowledge-graph` shows as connected.
3. Type `/hooks`: the `Stop` hook is listed.
4. Type `/exit`.

Then the same in project B:

```bash
cd "$DEMO_B" && claude
```

Do steps 1 to 4 again. In project B, `/hooks` also lists `UserPromptSubmit`
(context injection, switched on above so you can check it).

### 1.7 Open the vault in Obsidian

1. Open Obsidian, choose **Open folder as vault**, and pick
   `~/knowledge-graph-demo/vault`. Trust the vault's author if asked.
2. Open the graph view (the graph icon in the left ribbon, or Cmd+G).
   Notes are coloured by project: shortlinks blue, notes-api orange,
   billing-service grey.
3. Leave Obsidian open.

### 1.8 Rehearse once

Do Part 2 and Part 3 once on your own.

## Part 2: before each run (about 3 minutes)

### 2.1 Lay out the windows

| Window | What |
|--------|------|
| Obsidian | The graph view of `~/knowledge-graph-demo/vault` |
| Terminal 1 | The service terminal |
| Terminal 2 | Project A: `source ~/knowledge-graph-demo/demo.env && cd "$DEMO_A"` |
| Terminal 3 | Project B: `source ~/knowledge-graph-demo/demo.env && cd "$DEMO_B"` |

Close heavy apps: a loaded machine makes the captures slow. Quit anything else
that uses the local Ollama, such as an IDE's AI assistant (IntelliJ with
`qwen2.5-coder:32b` once held Ollama for 40 minutes): Ollama runs one large
model at a time here, so every capture and the warm-up queue behind it. Check
with `ollama ps`: before the warm-up, it should list nothing but `bge-large`
or `qwen3.5:9b`.

### 2.2 Start Ollama and the service

```bash
open -a Ollama
```

In terminal 1 (skip if the service is still running from Part 1):

```bash
cd ~/Personal/knowledge-graph
source ~/knowledge-graph-demo/demo.env
demo/service.sh "$DEMO_VAULT" 5678
```

### 2.3 Reset the vault and switch context injection off

In terminal 3:

```bash
~/Personal/knowledge-graph/demo/reset.sh "$DEMO_VAULT" --url "$KG_SERVICE_URL"
~/Personal/knowledge-graph/demo/injection.sh "$DEMO_B" off
```

Done when it prints `reindex complete: 13 notes, 13 embedded` and
`context injection off`. Don't reset while a run is in progress.

### 2.4 Warm the models

Also in terminal 3:

```bash
curl -s localhost:11434/api/generate -d '{"model":"qwen3.5:9b","prompt":"hi","stream":false,"think":false}' >/dev/null
curl -s -X POST "$KG_SERVICE_URL/webhook/knowledge-graph/search" -H 'Content-Type: application/json' -d '{"query":"warm up"}' >/dev/null
```

Both return in a few seconds with no output.

## Part 3: the demo (about 8 minutes)

### Step 0: set the scene (1 minute)

In Obsidian's graph view, show the seed: three projects' notes. Open the note
**Add rate limiting to the shortlinks create-link endpoint before launch**.
That's the job for today, in project A.

### Step 1: session A builds the rate limiter (about 2 minutes)

In terminal 2:

```bash
claude
```

Press **Shift+Tab** once, so the mode shows "accept edits". Paste:

```text
Add rate limiting to POST /links. Put a token bucket in a new src/rate-limit.js and use it in src/server.js: each client IP gets a bucket of 5 tokens that refills at one token every 12 seconds, so 5 new links a minute with bursts of up to 5. When the bucket is empty, answer 429 with a Retry-After header in seconds. Keep the buckets in a Map and drop any that have been full for 10 minutes. We're choosing a token bucket over a fixed-window counter because a fixed window lets a client send twice the limit across a window boundary, and keying by IP because shortlinks has no API keys yet; no Redis, since it runs as one process with no dependencies. Keep it dependency-free and reply briefly.
```

- Claude writes `src/rate-limit.js` and edits `src/server.js` (about 45 s).
- If it asks to run a check, approve it, or decline it and `/remember` will
  save a todo to test it.
- When the turn ends, the service terminal prints one `run ... complete` line
  per file over the next minute, and two new blue notes appear in the graph,
  linked to the seed.

### Step 2: `/remember` saves the decision (about 1 to 2 minutes)

In the same session:

```text
/remember
```

- The agent writes the memos itself, sends them, and waits for the run behind
  the code captures. It reports each memo and its links.
- If it says the run is still queued, it runs the check command again. Let it.
- Open the decision memo in Obsidian: context, choice, rejected alternatives.
- Type `/exit`.
- Still in terminal 2, start loading the Reader's model for step 5 in the
  background (it takes about 15 s and prints nothing):

  ```bash
  curl -s localhost:11434/api/generate -d '{"model":"qwen3.6:35b-a3b-coding","prompt":"hi","stream":false,"think":false}' >/dev/null &
  ```

### Step 3: session B, injection off (about 30 seconds)

In terminal 3:

```bash
claude
```

Paste:

```text
Before I add rate limiting to POST /notes here: how did I rate-limit link creation in shortlinks, and why that approach? Don't change any files yet.
```

- Claude loads the `recall` skill on its own, searches the graph, and opens
  the new notes.
- It answers: 5-token bucket per IP refilling every 12 s, 429 with
  `Retry-After`, a Map swept after 10 minutes; why token bucket, IP and no
  Redis. It ends with **Notes used**, citing the notes from step 1 and 2.
- Type `/exit`.

### Step 4: session B, injection on (about 30 seconds)

Still in terminal 3:

```bash
~/Personal/knowledge-graph/demo/injection.sh "$DEMO_B" on
claude
```

Paste the same prompt as step 3.

- The hook adds the three best notes before Claude reads the prompt, so
  Claude goes straight to `get_note` with no search.
- Press **Ctrl+O** to show the injected `<knowledge-graph-reference-notes>` block.
- If Claude searches anyway, the hook added nothing (it happened once in three
  rehearsal tries). The answer is the same, so carry on; to show injection,
  `/exit`, start `claude` again and paste the prompt again.
- Type `/exit`.

### Step 5: the same question, answered by a local model (about 20 seconds)

Still in terminal 3:

```bash
node ~/Personal/knowledge-graph/dist/ask.js "Before I add rate limiting to POST /notes here: how did I rate-limit link creation in shortlinks, and why that approach?"
```

- Each step prints as it happens: a search, then `get_note` on the new
  notes, then the answer.
- The answer gives the same facts as step 3, cited inline, and ends with
  **Notes used**.
- Say it: nothing in this step left the machine.

### Step 6: close (30 seconds)

Back in the graph view: the new notes from project A, linked to the seed. One
vault for every project, plain markdown, and the index rebuilds from the notes.

## Part 4: if something goes wrong

| If | Then |
|----|------|
| No `run ... complete` lines after step 1 | In session A, `/hooks` should list `Stop`. If not, the folder isn't trusted: redo 1.6. Carry on: `/remember` still writes memos |
| `/remember` says the service isn't running | Start it (2.2) and `/remember` again |
| Session B doesn't use recall on its own | Ask: `/recall how did I rate-limit link creation in shortlinks, and why?` |
| `knowledge-graph` tools are denied or missing | `/mcp` and approve the server |
| No live notes at all (Ollama down, runs failing) | Reset (2.3), then ask the fallback question in project B: `Before I add rate limiting to POST /notes here: how have I rate-limited APIs in my other projects, and why that approach? Don't change any files yet.` The seed alone answers it |

| Step 5 says the model is not pulled | Ask again with `KG_READER_MODEL=qwen3.5:9b` in front (about 30 s); pull the 35B model after the demo |

More cases are in [SCRIPT.md](SCRIPT.md#fallbacks).

## Part 5: afterwards

1. In terminal 1, press Ctrl+C to stop the service.
2. To run the demo again, start from Part 2. To recreate the projects from
   scratch: `demo/setup.sh ~/knowledge-graph-demo --force`, then redo the trust step
   (1.6), since the folders are new.

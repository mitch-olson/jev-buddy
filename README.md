# jev-buddy

A chat that writes files in a folder. Before each step, Jev decides which older lines the writer still needs, which tools to mount, and whether a shell command may run.

The writer is `openai/gpt-5-mini`. Jev is `typesafe-ai/jev`. Both go through the Vercel AI Gateway.

## Run

Set `AI_GATEWAY_API_KEY`, then:

```
bun install
bun run chat
```

The first yellow line is the empty folder for that session, under `runs/`.

```
bun run chat pong
```

That reuses `runs/pong`. A path uses that directory.

`/context` reprints the last Jev block. `/quit` leaves. Each session is written to `logs/`.

## Screen

Yellow is you. Magenta is Jev. Blue is the writer.

Red lines in the Jev block were held back. Green lines were sent. Cyan lines are pinned: everything you typed, and the current turn. The bar is the history. Green is the part the writer receives.

`write` creates files. `edit` changes a file that already exists. `read` opens one. `bash` runs only after a second Jev check, and only inside the session folder.

## Files

`src/chat.ts` is the session. `src/decide.ts` asks Jev. `src/policy.ts` keeps a cached prefix unless the dropped text is large enough to pay for a cold start. `src/tools.ts` is the disk. `src/view.ts` splits long messages into pieces.

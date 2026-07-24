# Streaming Handbrake

A SillyTavern extension that watches AI responses *as they stream* and hits the
brakes the moment a bad pattern shows up — instead of trimming/replacing text
like regex rules do, it just stops generation outright.

Useful for: catching slop phrases, hallucination tells, refusal boilerplate,
or anything else you'd rather not sit through a full generation to see.

## Install

1. In SillyTavern, go to **Extensions → Install extension**, and choose
   "Install from local files" / drag-and-drop this folder, **or**
   copy the `streaming-handbrake` folder into:
   `SillyTavern/data/<your-handle>/extensions/`
   (or `public/scripts/extensions/third-party/` if installing for all users).
2. Reload SillyTavern. You'll see a **Streaming Handbrake** panel in the
   Extensions settings drawer.

## Usage

- Toggle **Enabled** to turn detection on/off globally.
- Add **triggers**: a label (optional, just for your own reference), and a
  pattern. By default patterns are plain substrings, case-insensitive.
  Check **regex** to use a full JavaScript regular expression instead
  (e.g. `(\.\s*){6,}` to catch a run of trailing dots).
- **Trim the offending text**: if checked, the message is cut back to just
  before the matched text before generation is stopped, so you don't end up
  with the slop sitting in your chat log. Uncheck if you'd rather see exactly
  what triggered it.
- **Show a toast**: pops a small notification naming which trigger fired.

## How it works

It listens to SillyTavern's `STREAM_TOKEN_RECEIVED` event, which fires as
each token comes in during a streaming generation. On every token, it checks
the accumulated response text against your enabled triggers. On a match, it:

1. Optionally truncates the in-progress message.
2. Optionally shows a toast.
3. Stops generation — by clicking SillyTavern's built-in stop button, or (if
   that's not available) dispatching an `Escape` keypress, which ST also
   binds to interrupting generation.

## Notes / limitations

- Only works with **streaming** generation enabled in your API settings —
  there's nothing to inspect token-by-token otherwise.
- The "stop" mechanism relies on SillyTavern's UI (stop button / Escape
  binding) since there isn't a documented public API to abort generation
  directly. This has been reliable across recent versions, but if a future
  ST update changes the stop button's element ID, that part may need a
  one-line fix in `index.js` (`pullHandbrake()`).
- Regex patterns are user-supplied and run via `new RegExp()` — keep them
  reasonable in complexity to avoid slowing down fast streams.

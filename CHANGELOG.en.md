# Changelog

> Feature change log of AI-KM; the in-app **Settings → Help → Changelog** page shows the same file.
> Chinese version: [CHANGELOG.md](CHANGELOG.md)
> Convention: user-visible changes are appended to the **top-most date section**; basic Markdown only (`##` date, `###` category, `-` entry, inline code).
> **Keep it short**: one sentence per entry — "what changed + impact"; no implementation details, code paths, previous-implementation comparisons or examples; merge similar changes into one entry; **prefer ≤ 15 entries per day (20 max)**.

---

## 2026-09-24

### Added

- **Changelog in English**: when the UI language is English the Help page now shows `CHANGELOG.en.md` instead of always showing the Chinese content.

### Improved

- **Chat titles follow the UI language**: the first automatic title on Home is generated in the current UI language (English UI ⇒ English title).
- **Changelog moved to the repository root and renamed**: `docs/help/更新日志.md` → root `CHANGELOG.md` (English mirror `CHANGELOG.en.md`); README and the in-app Help page point to the same content.
- **README rewritten**: restructured for repository visitors (intro / features / tech stack / install and build / docs and changelog / license) and linked to the changelog.
- **"Agent CLI" renamed to "Agent 脚手架" (Agent Scaffold in English)**: navigation bar, Settings → feature switches, the whole Help chapter, the manual and the README were renamed (the misleading "CLI" wording is gone); existing configs migrate the current panel and feature switches automatically, so returning users still land on the same panel.
- **Repository slimmed down, internal material moved out of the way**: two temporary root scripts, six one-off build/diagnostic scripts under `docs/help` and 13 design documents under `docs/plan` (merged into a local `docs/设计决策记录.md`) were removed; the manual and the Linux packaging guide moved to `manual/`, and the one-click packaging script to `scripts/build-linux-all.sh`; `docs/` is excluded from the repository and README links were updated.
- **Manual synced with the current software**: fixed section numbering (workflow 8.x / skills 9.x / todo 12.x / settings 13.x) and cross-references; added Data Canvas and Browser Agent to the navigation overview, renamed the English label to Agent Scaffold, and updated counts (workflow nodes, 13 Help tabs) against the code.
- **Large assets are user-provided, repository slimmed down further**: `scripts/` keeps only six build/resource helpers (one-off diagnostics and test fixtures stay local), the offline map package `public/maps/*.mbtiles` (~30 MB) is not committed and is built with `scripts/make-builtin-mbtiles.py`; the README gained an "Optional local assets" section (map package / drawio runtime / Excalidraw dev assets) and the manual was synced; measured commit size dropped from 48 MB to 17.6 MB.
- **Dev scripts tidied up**: the Windows entry point for one-click Linux packaging (`build-linux-all.cmd`) moved into `scripts/` next to the `.sh` (usage unchanged, still double-clickable), and all other one-off diagnostics, test fixtures and probe artifacts (~118 MB) were deleted locally.
- **`.gitignore` extended**: ignores the Excalidraw dev assets and the browser profiles produced by probe scripts (hundreds of MB) as well as temporary scripts and demo pages, so no useless large files are uploaded.

### Fixed

- **Agent Scaffold still showed Chinese in the English UI**: status bar (`共`/`出错`), round names and cross-round references (第1轮 → Round 1, normalized when old task files are opened, including references inside prompts), result-page and Excel column headers (`_行号` / `_轮次·` / `_来源`), the default result column name, log-page thread labels, graph tooltips and kind names, and instance tab names (Agent脚手架 1 → Agent Scaffold 1) now all follow the UI language.
- **Renamed export columns had no values on the result page or in Excel**: after renaming a custom column the header used the old name while the data used the new one (blank cells on the result page, shifted columns in the exported Excel); both now use the same column name.

---

## 2026-09-23

### Fixed

- **Agent scaffold: deleting a few rows marked the whole sheet as changed**: comparison used to run on whole-row text, so re-saving the Excel (thousand separators, a stray `.0`, padding spaces) flagged every row; a **normalized fingerprint** now decides what really changed, and rows are re-identified by their **first non-empty cell** when fingerprints do not match — deleting a few rows reports only those rows and results no longer shift. Task files without fingerprints only report row counts (restored after one re-run).
- **Agent scaffold: "Sync source" alignment and messages**: alignment no longer silently falls back to row numbers and no longer pops self-contradictory dialogs such as "only recognized 712/21021 rows"; such notes now appear compactly in the bottom-left status bar (plus a "row count changes only" hint).
- **Agent scaffold: results follow "Sync source"**: syncing / re-importing immediately rewrites the current round snapshot, so round switching, comparison and saving all use the synced results; **results of rows deleted from the source table are removed automatically** (results follow the source table in every mode). Only when alignment is unreliable (more than half of the rows deleted) are they kept and merely marked "removed", which the "Removed N" button on the results page lets you review and handle manually.
- **Agent scaffold: delta statistics no longer inflated by misalignment**: when insert/delete positions cannot be determined reliably (old task file, moved rows, heavily edited table) the delta reports **row-count change (net)** only, instead of pairs such as "added 872 / removed 889"; reliable cases are still pinpointed to individual rows.
- **Agent scaffold: results shifted after inserting or deleting source rows**: rows used to be matched by row number, so inserting a row in the middle attached every later result to the wrong row; matching by row fingerprint no longer mixes up results when rows are added, removed or reordered.
- **Agent scaffold: exported Excel column order differed from the results preview**: after dragging the exported columns into a custom order, the Excel header now follows that list exactly instead of the internal default order.
- **DeepSeek reduced to a single source**: "DeepSeek Responses" in Settings is merged into "DeepSeek" (switch Chat Completions / Responses API with "API style"), so Home, presets, workflows, knowledge base and OCR no longer list a duplicate DeepSeek Responses; existing data migrates automatically (source list, disabled flags and connection state are all normalized).
- **Home chat UI unified**: the chat-list toggle moved to the left of the chat title (**☰**, icon only, no button box, **chat list hidden by default**, one click to expand); an empty chat no longer shows the title input — the composer is centered, narrower and accompanied by a hint, and slides smoothly back to the bottom on the first message; **chats with messages use the same rounded input card (full width, no max width)**; the text area and the mode picker / attachment / voice / send controls inside the card are all **borderless**; **"Stop generating" takes the place of the send button** (stop while generating or running, send when idle); **status hints such as "Generating / Retrieving / Testing connection" now show a single icon** (the text lives in its tooltip, sized like the attachment button) instead of occupying the space above the composer; in the chat-list sidebar the **search / new buttons and every chat row are 30px high** and aligned with the title box; **a chat running a swarm shows the same spinner in the chat list** as a running agent; **uploading attachments is no longer blocked while generating** (attachments go out with the next message); extra spacing between messages and the input card; **the input card and the dropdowns / inputs inside it now use the normal background colour** (not the menu / card colour), and hover states and option lists no longer switch to the menu highlight colour; the input no longer overflows the card; **the linked-item chip moved to the left of the mode dropdown**; when an agent writes a local web page (`.html`), the tool card gains an **"Open" button** next to "Show details" so you can preview it in the built-in browser; **errors returned by the system / model service** (e.g. "model service returned an error / Context size has been exceeded") now also show a **red exclamation icon** on the input row (hover for the full error, click to dismiss) besides the chat message.

### Added

- **Agent scaffold: new "Sync source" button**: while a task is open, add, remove or edit rows in Excel (or add / remove files in the folder) and click "Sync source" in the Details toolbar to re-read the source table and re-align — no need to reopen the task; importing the same table file again now **replaces rows** instead of appending and doubling the row count.
- **Agent scaffold: source-table deltas are visible**: after re-reading the table (or clicking "Sync source"), changed rows are tagged `added` / `changed` (**changed = same row, its result stays on that row**, only the source data changed and a re-run is recommended) and deleted rows are tagged "removed" (their results stay on the results page); the toolbar shows a "+added ~changed -removed" summary, and a new "Delta" filter shows only added or changed rows.
- **Agent scaffold: see where the changes are after adding or removing rows**: in the toolbar's "+added ~changed -removed" summary, click **added** / **changed** to filter the table below (click again to clear); hovering shows column-level differences (added / missing / reordered) and the alignment note — the separate "View changes" panel is gone.
- **Agent scaffold: results can be traced back to task rows**: the results table gains a "Task row" column that jumps to and highlights the row in Details; results of rows deleted from the source table stay on the results page tagged "removed", and a "**Removed N**" button appears (only when relevant); the "Removed N" button in the Details toolbar is clickable too and jumps straight to them.
- **Agent scaffold: understand results that outnumber task rows**: the results page footer now reports, for example, "8 results / 6 task rows: 1 row with several results, 2 without a task row, 1 removed"; orphan results can be filtered with the toolbar's "**Orphan N**" button and then removed with "**Delete these**" (the neighbouring "**Clear**" only clears the filter); a new "**Sync results**" rebuilds the results from the current task rows (each row keeps only the records it produced, row numbers and data re-aligned) so counts and data match the task rows.
- **Agent scaffold: custom names for exported columns**: click a column name in the export list to rename it (Enter or blur applies it, empty restores the default); the results header and the exported Excel both use the new name, and renamed columns show their original name (also on hover in the results header).
- **Agent scaffold: delete individual results**: a delete icon at the far right of the results table removes that record (structured extraction also removes what it wrote back to the source table) while the task row remains and can be re-run.
- **Agent scaffold: choose "replace or keep" when re-running**: "Output → Re-run results" gained an option (default "replace this row's previous results") that clears the earlier records before re-running, so results do not pile up (old results are kept if the run fails); pick "keep and merge" when several rows should be summarized into one.

### Improved

- **Agent scaffold: the instance bar's "Start / Pause" follows each instance's task state**: "Start" only appears when the instance has pending rows, "Pause" only while it is running, and neither takes up space when there is nothing to do (updates as you switch instance tabs).
- **Agent scaffold: exporting large Excel files no longer freezes the UI**: exports are written in chunks (2000 rows each, yielding between chunks) with an "exporting x/y rows" progress in the status bar and the button greyed out as "Exporting…"; content, column order and custom column names are unchanged.
- **Agent scaffold: concurrency limit raised to 500** ("Run → Concurrency") so large batches run in one go; the log page shows at most 60 thread tabs to keep the tab strip usable.
- **Agent scaffold: output-panel notes moved into tooltips**: the permanent explanations under "Output mode", "Output fields" and "Export columns" are now tooltips on the titles / dropdowns, making the panel more compact.
- **Agent scaffold: output panel bottom padding and alignment**: the export-column list no longer sticks to the panel's bottom edge (consistent padding bottom-right).

## 2026-09-22

### Fixed

- **Fixed local model gateways dropping tool arguments and making the agent retry**: some gateways (GPUStack, LM Studio, …) returned empty or truncated call arguments, so tools ran with no arguments ("code is required") and the model retried endlessly; the raw streamed arguments are now used as a fallback and an explicit message (including whether the payload was truncated) is shown when they really cannot be parsed, instead of silently treating them as empty.
- **Fixed tool-card display**: streamed code / commands are no longer overwritten by a later empty argument set (`{}`), and a failing `run_code` shows the real error instead of "running…" forever.
- Fixed the type-check errors in the Help page's data-canvas and browser step numbering so the project passes the renderer type check again.
- **Fixed "Re-run this row" in the row details also running other pending rows**: when nothing was running, re-running started a batch from the earliest pending row; now only that row runs (the log states how many pending rows were left out — use Start on the task page for the whole batch).
- **Fixed the folder-source extension / excluded-directory fields appearing unsaved**: both settings were stored in the task file but were not filled back into the inputs (they showed defaults and a further scan overwrote them) — they are now restored when the task opens and written back on edit (blur or Enter).
- **Fixed "Scan folder" failing to create task rows**: after choosing a folder source, scanning reported "scan failed: An object could not be cloned." — it now creates one task row per file as expected (existing files are still skipped).
- **Agent scaffold: import / read progress of large tables jumped to the far left of the status bar**: the row count now refreshes every 5000 rows (like the earlier feature of the same name) instead of leaving the UI looking frozen.
- **Agent scaffold: the comparison page can finally be scrolled when there are many rows** (content used to be clipped); the cell preview dialog is no longer limited to a 400px default width and the comparison table no longer has two nested borders.

### Added

- **Custom (intranet) search sources in Search settings**: the **+** on the left adds any number of sources — either "SearXNG-compatible instance" or "HTTP JSON endpoint" — with IP:port, a `{query}` placeholder, request headers / token and result field mapping; they sort by drag together with the built-in sources and can be enabled and tested (the ↺ reset also clears custom sources).
- **Home: guide a running agent by typing**: the input is no longer locked while an agent or swarm runs — Enter delivers your text as "guidance" to the running agent (the current round is not interrupted; the next step carries it); guidance is inserted into the step timeline where it takes effect (later steps are listed below it), which is clearer than sending another bubble; if the round just finished, it is sent as a normal new task.
- **Agent scaffold: "Clear results" on the results page**: clears only results (per-row result / status / tokens / timing / process snapshot and the extracted data table) while task rows and configuration stay, and rows return to "pending" for re-running.
- **draw.io diagrams: "Export as → PDF" and "File → Print"**: routed through the app's local printing path (works offline, prints the current page only, and printing opens the system print dialog).
- **Agent scaffold: duration filter**: same specification as the step filter (`< ≤ > ≥ =` plus a value; seconds by default, `90` / `1.5m` / `2m30s` / `1h` all accepted), with unrun rows counting as 0 — filter out rows that reasoned too fast and re-run them with "Re-run → current filtered rows".
- **Agent scaffold: one filter panel with batch status changes**: status / search / result / row number / steps / duration are configured in a single "Filter" panel that shows the number of matching rows live; matching rows can be marked pending / skipped / completed / failed in one click ("pending" = to run, started on the next launch) or re-run immediately with "Re-run matching rows".
- **Agent scaffold: "empty result" switch in the filter panel**: one click filters rows whose result is empty (equivalent to the `|''` form of the result filter, and stackable with keywords) — handy before re-running.
- **Agent scaffold: slimmer Details toolbar**: "Re-run ▾ / Import table / Reset" removed — re-running now targets the current filter's matching rows (one click in the panel: queued immediately while running, otherwise marked pending and started), and import / reset live on the Task page.
- **Agent CLI: the instance bar's Start / Pause / Save now act on the current tab's task only** (they used to affect every open instance); hold Ctrl / ⌘ / Alt and click to apply them to all instances.
- **Agent scaffold: pure LLM inference also counts row tokens**: previously only agent-mode rows had tokens; "pure LLM inference" rows (per-column write-back / structured extraction) now show input / output tokens too (details table, row details and exported columns), overwritten by the current round when re-run.
- **Agent scaffold: row actions consolidated in the row details panel**: the "Action" column of the details table only shows status text (the status dropdown and the re-run / delete icons are gone), and the bottom bar is ordered status selector → stop (while running) → re-run (otherwise) → delete, with Close on the right.
- **Agent scaffold: stop a single row**: a running row cancels its session / request and a queued row leaves the queue, then both are marked "skipped" — other rows and the batch keep running.
- **Agent scaffold: click a cell on the comparison page to render a preview**: clicking any round's output opens a Markdown-rendered dialog titled with that round, and the comparison table always lists every row (rows that only exist in another round show `—`).

### Improved

- **Agent scaffold: filter by "result or a specific field"**: the "Result" row of the filter panel became "field + keyword" — the result column by default, or a specific extracted field / source column (including columns written back); keywords still support `|` for alternatives and the "empty" switch follows the selected column.
- **Agent scaffold: results page loads progressively with search / filter / jump**: instead of a fixed preview of the first 500 rows, scrolling to the end keeps loading (200 rows per batch); the toolbar gained keyword search across all columns, per-column filtering (value contains; column only = non-empty rows) and row-number jump with highlight; exports still write every row regardless of search / filter.
- **Agent scaffold: segmented inference of large files no longer produces multiple rows**: when one task row is split into several inference segments during structured extraction, the segments are merged field by field into **one record** by default (text fields joined in segment order, duplicates removed) — one file yields one record; switch "Output → Segmented results" to "one record per segment" when a file holds several independent records.
- **Agent scaffold: folder-source task rows are generated when the task opens**: a task whose source is "Folder (scan local files)" rescans the directory when the instance is opened next (or a `.task` is double-clicked), rebuilding the task rows and merging the saved results / status back by row (consistent with table sources re-reading the sheet).
- **Agent scaffold: built-in help trimmed**: the "DeepSeek Responses" paragraph was removed (that explanation already lives in the Task page's capability tooltip), making the help page shorter.
- **Naming unified: the scaffold is now called "Agent Scaffold"**: the "generic pipeline / unified pipeline" wording is gone from the help centre, the manual, instance titles, settings and hints in both languages; automatically generated titles of existing instances migrate, manually renamed ones do not.
- **Agent scaffold: no more two-column intermediate state on the Task page**: below roughly 900px the page goes straight to a single column (configuration → input → output); wide windows keep three columns.
- **Agent scaffold: the Task page's "Export columns" list fills the remaining height of the output panel**: taller windows show more items (it used to be fixed at 176px) while the list still scrolls internally.
- **Agent scaffold: the "problem rows only" button was removed from the comparison page**: inconsistent rows already have an orange background and a ⚠ / ? marker (and the button used to empty the page).
- **Agent scaffold: the round chips on the comparison page always keep at least one round**: turning one off simply shows the remaining round (the table no longer goes blank) and all rounds cannot be turned off.
- **Agent scaffold: the row details "Output" renders streamed Markdown**: no more raw Markdown source — headings, lists and tables take shape while the model runs (rendering is coalesced every ~150ms to avoid stutter), and the finished output uses the same rendering.
- **Agent CLI: cleaner empty state**: the instance bar is hidden when there are no instances (its five buttons did nothing) and the empty state is a single sentence plus "New task / Open task" buttons (the shortcut creation and bottom hints are gone).
- **Agent scaffold: the row details footer uses a "Status" dropdown**: it replaces the "Re-run / Skip" buttons and sets the row to pending / completed / failed / skipped directly (status only, results untouched; "pending" = to run, click Start on the Task page to execute it), and a running row cannot be changed.
- **Agent scaffold: the graph now smooth-zooms and centres once after layout converges**: the view is no longer adjusted while the layout runs (which used to jitter); opening starts with a wide view estimated from the node count and, once the layout settles, all nodes are fitted and centred in the viewport (manual zoom / pan afterwards is left alone).
- **Agent scaffold: the row details footer tidied into one row**: "Copy / Edit" moved from the tab corner into the button bar (same row as status, delete and close), the bottom buttons and dropdown share one height, and the status dropdown lost its background and left-hand label (the explanation moved into the tooltip).
- **Agent scaffold: export columns became a vertical form**: source columns / run-info columns / results of each round are merged into one list with per-item checkboxes and drag handles for ordering (the order is the exported column order), each marked with its origin.
- **Agent scaffold: tool calls in the row details "Process" tab are a single-line summary by default**: same look as the Home tool boxes (icon + tool name + status + expand arrow); clicking expands parameters and results (long content scrolls) instead of filling half the screen immediately.
- **Batch agents: the system prompt now matches Home / Workflow / Swarm exactly**: the batch-only closing "language requirement" paragraph is gone (the output language comes from the task and preset prompts) and only "remove the ask-user tool" remains as a difference.
- **Knowledge base file view**: the search box moved from the bottom status bar to the right of the top toolbar, the bottom bar no longer shows the current path, and the file count moved to the bottom right.
- **draw.io diagrams: saving is manual again**: edits are no longer written automatically (the save button shows an orange dot when unsaved) — click 💾 or press `Ctrl+S` to write the file and get a "saved" toast; switching tabs, changing theme or closing the window still saves silently as a safety net.
- **Agent CLI: status feedback consolidated in the bottom status bar**: the run state (spinner + "running…") moved to the far left of the status bar and the left-hand "Start" button only greys out instead of reading "running…"; "saving / saved / cancelled / failed" for the instance bar's Save and the results page's "Export Excel" also appear on the left of the status bar, success and cancellation no longer pop dialogs and fade after a few seconds (hover for failure details), and saving several instances is summarized in one line.
- **The agent reading large files no longer stops at the first chunk**: when a single read exceeds the length limit the truncation point is reported and reading can continue automatically until the end (PDF / Word / Excel 20k characters per read, plain text about 100KB).
- **Tools gained skill addressing (the `skill` parameter)**: `read_file` / `list_dir` / `search_files` accept a skill name and resolve the path relative to that skill's directory, so relative paths such as `regulations/x.md` inside a skill work without depending on the working directory.

### Fixed

- **The working directory of agent tools is no longer changed by skills**: selecting a skill in a preset no longer switches the tool working directory to the skill library (asking "what files are in the workspace" used to answer with the skill folder); it is always the current workspace.
- **Agents (chat / batch / workflow / swarm): the skill library loads from one place**: changes to the skill folder take effect immediately (no more stale directory) and batch runs inject the skill list and the preset's selected skills correctly.
- **The `skill` tool no longer reports "skill not found"**: case and underscore differences in skill names are matched automatically, and a genuinely unknown name returns the list of available skills so the model can retry.
- **Agent scaffold: Markdown in the row details "Output" is no longer stretched**: every source line break used to be treated as a hard break, inflating a report by about 70%; the fix applies only to monospaced streamed output / errors and tightens heading and paragraph spacing, cutting the same content to roughly 40% of its previous height.
- **Agent scaffold: rows whose structured extraction produced no JSON no longer lose their content**: when the model replied with prose instead of JSON the row had no extracted data and the raw text was dropped, so it never appeared in the exported data table — the raw text now stays on the row (visible under "Output" in the row details) and the export **automatically adds a "Raw output" column** for it; the number of unparsed rows is reported at the end and, if "empty content handling" is set to automatic re-run, they are retried.
- **Agent scaffold: row tokens no longer accumulate across re-runs**: a row's tokens (same basis as start / end time and steps) describe the current round only — re-running used to keep adding to the previous figure.
- **Help page copy fixes**: asterisks in the Agent scaffold description are no longer shown literally, and a duplicated fragment in the English version was removed.
- **Agent scaffold: more robust Excel export**: cells beyond Excel's limit (32767 characters) or containing illegal control characters no longer fail the whole export — over-long content is truncated and flagged, and export failures are reported in the status bar (they used to be logged only).

---

## 2026-09-21

### Added

- **Agent scaffold: rounds (multi-round processing)**: the Task page can create / switch / rename / delete rounds (each round keeps its own configuration snapshot and results, stored in slots of the task file, and old files become round 1); `{{Round1.Result}}` references a previous round's output, ⑂ expands the current results into a new round's task rows, and the "Compare" tab shows the rounds side by side and flags inconsistent rows.
- **Agent scaffold: "Output mode", presets and "Export columns"**: output can be "plain results / structured extraction", a preset applies one of the four former scaffolds in one click, and the Excel export can combine source columns and run-info columns into one table (unchanged behaviour when nothing is selected).
- **Agent scaffold: "Keep with task file" and a graph switch**: graph data / run logs can optionally be stored with the task file (not kept by default, which keeps files small), and the graph can be disabled in the task configuration (no trajectory projection, graph tab hidden).
- **Agent scaffold: "Text (one per line)" source**: pasted text becomes one task row per line, and each line can be "used as-is / read a local file / fetch a web page" (fetching is link collection with link following and a page limit).
- **Agent scaffold: step filter on the Details page**: filter rows by reasoning steps (<, ≤, >, ≥, =), with unrun rows counting as 0 — combine with "Re-run → current filtered rows" to top up rows with too few steps.
- **Agent scaffold: step counts are stored with the task file**: the per-row step count no longer lives only in memory (it used to survive only indirectly via "graph data"), so the steps column, the step filter and exports work after reopening; process snapshots are still kept on demand.
- **Agent scaffold: the page split into Task / Details / Results / Compare / Graph / Logs / Help tabs**: Details gained run metadata and structured-extraction field columns, the Results page is the export preview, and a "subtask title" and source path are shown.
- **Trajectory graph: new "visit path" view plus agent / MCP service nodes**: every row becomes an "agent" node (rows that called no tool still show as a single node) with edges to visited pages / files / searches / knowledge bases and to the MCP services used; the node limit is configurable (2000 by default).
- **Batch agents / Home PTC**: a "row range" filter and "Re-run ▾" for a selected range (with a preview of matching rows before execution); Home gained the PTC chat mode, where the model writes a program that composes tool calls through `run_code`.

### Improved

- **Agent CLI: the single scaffold is named "Agent Scaffold" and instance handling improved**: the four former scaffolds became its four presets (opening an old `.task` converts it automatically), instance actions live permanently in the navigation bar, "Data Canvas" became a top-level module, new instances no longer pre-create a task file (the location is chosen on first save), and save feedback moved to the left of the status bar.
- **Agent scaffold: Task page layout converged and output fields merged**: three columns, a sticky action bar, independently scrolling panels and automatic column reduction on narrow windows; "task template / goal / source columns" became "task instruction + data selection", "output fields" merged into one list shared by write-back and structured extraction, and written-back results can be viewed / edited in the row details.
- **Agent scaffold: row details became "Task / Process / Output" tabs**: tabs on the left, run counters (start / end / duration / steps / tokens) on the right and the copy / edit buttons next to the tabs; the selected tab is remembered so opening further rows does not require switching again.
- **Trajectory graph: the default view follows the task** (web rows → crawl trajectory, otherwise → visit path) with an empty-state explanation; new nodes move in from outside the viewport and the toolbar became a coloured legend (click to filter).
- **Batch agents / PTC**: re-running a range while idle no longer drags in other pending rows, batch re-runs during a run are queued once, the task template defaults to 10 rows, and PTC sub-call arguments are no longer echoed back into the model context.
- **Settings → General: the "Agent CLI" switch block was removed** (only Agent Scaffold remains, so it needs no switch).

### Fixed

- **Agent scaffold: task language follows**: when a preset defines no system prompt, an English task was answered in Chinese because of the built-in Chinese prompt — "answer in the task language" is now appended.
- **Trajectory graph: the whole graph was relaid out on every data change (constant flicker)**: it now updates incrementally (nodes / edges are reused and only structural changes reheat the simulation); window minimization refreshes on a microtask; arrow colours for small graphs were filled in and the first-frame zoom that made graphs disappear was fixed.
- **Agent presets: the model dropdown was empty after changing the provider**, and a failed provider probe no longer aborts loading the AI configuration.
- **Qwen3-ASR upgrade**: new "streaming (near real-time by segment)" mode (text appears as you speak, cut at pauses) and web-service options / parameters (language, punctuation, speakers, line limit); the OpenAI-compatible endpoint still works.
- **Speech recognition "hold to talk" returned nothing**: the recorded audio was cleared early for all three engines (Whisper API / Whisper Python / Qwen3-ASR), so results were always empty — fixed.

---

## 2026-09-20

### Added

- **Agent CLI supports multiple instances**: each instance is one task plus one `.task` file (the limit depends on the type); a new instance bar and ☰ menu (open from file / new instance / start all / pause all / **save all**) show the run state on the tab, file and ETA on hover, allow renaming or closing, keep running when you switch away, and read the task file only when the instance is entered.
- **Task files (`.task`) carry a type marker**: double-clicking opens (or activates) the matching instance, a file cannot belong to two instances, and **Data Canvas** also saves to `.task` (auto-saved 1.5s after a change).
- **New built-in "PostgreSQL query" MCP service** (7 tools): read-only SQL and author disambiguation with three layers of read-only protection, automatic schema adaptation and optional HTTP exposure.
- **Better author disambiguation**: batch mode (up to 200 per call), tolerance for periods and missing middle names / initials (`Mark Perazella` → `Mark A. Perazella`), merging fragmented profiles into the main one, and more compact output.
- **Ollama / LM Studio model panel**: lists type (chat / vision / embedding), whether a model is loaded and the effective or configured context limit, with one-click load / unload; the embedding dropdown lists embedding models only.
- **Instance tab tooltips show progress and ETA** (refreshed every second).

### Improved

- **Model settings page**: the refresh entry point is unified on "API status", the LM Studio grid aligns and is no longer height-limited, Ollama / LM Studio no longer repeat "context window", and unreachable services give a single readable reason.
- **Fewer MCP call errors**: the tool list includes required / optional parameter signatures, `mcp_call` blocks missing required parameters early, Office tools reuse the only open document when the session ID is omitted, and parameter aliases are normalized.
- **PostgreSQL query**: automatic schema adaptation, actionable error messages, and a server-side gate plus result cache for concurrent calls.
- **Author disambiguation is much faster**: a name-index fast path (15–20s → milliseconds per record), the query pattern that forced a full table scan removed, and one shared scan per batch (about 0.8s for three records).
- **Tray area and ☰ menu**: tray tooltips list progress and remaining time per instance; "pause all" gives feedback and yields the main thread instead of looking frozen.
- **Agent CLI details**: the title bar matches other panels, the instance bar height and icons align, and the bottom status bar is no longer pushed out of view.

### Fixed

- **Batch tables**: scrolling up after a jump did nothing / left blank space above; dragging to select text no longer opens row details or closes dialogs by accident.
- **Opening a large task occasionally reported "table parse cache not found"**: instance-level loading is merged and the main-process parse cache uses reference counting.
- **Newly created agents were missing from the console** (the event bridge dropped unknown sessions → a placeholder view is created and polled cheaply).
- **Table reasoning: with many imported columns the "source column" list was pushed out of view** (now a single vertical column with a sticky header).
- **PostgreSQL**: statement timeouts were clamped to 1 second by mistake (defaults of 30 seconds / 50 rows apply when unconfigured), and `pg_resolve_author` no longer times out on very large databases.
- **Excel / Word MCP tools**: clearer messages when the session ID is missing and unified parameter aliases (`workbook_id` / `file_path`, …).

---

## 2026-09-19

### Added

- **Built-in literature search MCP service** (no API key): CrossRef / OpenAlex / arXiv / PubMed / Europe PMC search, author lookup, retraction checks and open-access full text (9 tools).
- **Configurable web search sources**: key-free Bing / Baidu / DuckDuckGo, self-hosted SearXNG and keyed Bocha / Zhipu / Tavily / Brave, with sequential fallback or parallel aggregation, per-source testing, drag ordering and one-click reset; the workflow "web search" node uses the same sources.
- **Configurable MCP call timeout** (empty = 60 seconds).
- **The close button can minimize to the tray** (new "close button behaviour" setting): when collapsed, closing the window does not quit and background tasks keep running; the tray tooltip shows task count and progress, and its context menu can show the main window / settings / background tasks / quit.

### Improved

- The "Search" settings page now matches the "Models" page layout; Bing Chinese query rewriting can be toggled; search failures mention the source and channel; document links open in the built-in browser.

### Fixed

- **Occasional 30-second `mcp_call` timeouts**: the default timeout is 60 seconds and configurable per service, and the multi-source literature tools run concurrently (worst case about 50s → about 15s).
- Bold / inline-code markers in the Help page "built-in MCP services" card were not rendered.
- Over-long copy on the "Search" settings page caused a horizontal scrollbar.

---

## 2026-09-18

### Added

- **Document smart actions**: the ✨ button in the browse view's status bar chats about the current document and can attach the whole document / current section / selected text (limit about 120k characters, with a truncation notice).
- **Export Markdown / Word / PDF**: the ⬇ menu in the status bar; exporting Word opens a Save-as dialog offering official-document / Chinese-paper / English-paper (APA 7) / custom `.docx` templates and a destination folder.
- **Context window and usage ring**: the context usage ratio is shown next to the Home chat title, and each provider on the "Models" page shows a read-only window denominator and override.
- **Batch agent runs** (Agent CLI): table-driven batch tasks with placeholder templates, concurrency / retries / resume and Excel result export.
- **Table reasoning** (Agent CLI): configure instructions per "source column → target column" and let the LLM fill values row by row.
- **Tabular credential management**: name / masked key / updated time / actions, with Enter for consecutive additions and same-name overwrite.
- **New common actions**: export Markdown, back up data, open the data folder, clear session logs.
- **Settings navigation reworked**: "Associations" added; "System" removed, with path settings and common actions moved into "General" and system status into "Other".
- **New "Changelog" tab in the Help page** (this file), replacing the FAQ tab.

### Improved

- Help page: consistent description lengths plus new sections for draw.io diagrams, document smart actions and the context window.
- Tool management is per-tool (18 tools), and presets and swarm members share the same per-tool list.
- The changelog goes back to 2026-07 with shortened entries.

### Fixed

- Help page HTML tags in settings descriptions were not rendered, and the third built-in MCP service was not shown.

---

## 2026-09-17

### Added

- **Built-in Office document MCP service** (Word + Excel, 29 functions): find / rewrite a paragraph / insert tables and Markdown / styling, range reads / filter-sort / group-aggregate / batch writes; write-back touches only the relevant XML part and creates a `.bak` backup.
- **The `export_word` tool** and a **workflow Word export node** (disabled by default, enabled in tool management).
- **Agent mode accepts images** (multimodal) and text attachments.
- **Model provider management**: providers can be disabled individually, several custom providers are supported and bound per chat; bare GPUStack addresses get `/v1-openai` appended.
- **DeepSeek**: API style switching (Chat Completions / Responses), account balance query and web search.
- **Selectable OCR providers** (Ollama / LM Studio / DeepSeek / custom, …), fixing whole-page recognition failures caused by a remote Ollama loop.
- **Settings**: reasoning effort, provider connection test row, shared document-folder panel.
- **Close protection**: a reminder before closing the window while background tasks run.

### Improved

- Session logs started recording the system prompt; swarm role grouping and preset entry points were tidied.

### Fixed

- Checkboxes / radio buttons were invisible in the dark theme; OOXML write-back compatibility for Excel and Word.

---

## 2026-09-15 ~ 09-16

### Added

- **draw.io diagram view**: `.drawio` / `.dio` files open in the built-in editor from the browse / source-edit / visual-edit / mind-map / presentation views, **fully offline**; the new-file dialog gained a draw.io type.
- **Diagram smart actions (AI)**: the ✨ button adds / adjusts (position, size, text, colour, layer, connector) / deletes shapes from a natural-language request, previews on the canvas before writing and can be cancelled; "auto-adjustable / add only" modes.
- **Diagram collaborative editing**: uses draw.io's official diffSync incremental protocol, with only the host writing to disk and starting AI operations.
- **drawio built-in MCP service** (44 functions): agents read and write `.drawio` XML directly (add / edit / delete, layout, Mermaid / CSV / SVG conversion, …).
- **Built-in services exposed over HTTP**: for external MCP clients such as Claude Desktop and Cursor.

### Improved

- Word export converts maths to native **editable Word equations** (OMML) where possible; the block editor supports formula paragraphs.

### Fixed

- draw.io "Export as → Download / Save to device" did nothing (now uses the native save dialog); other windows did not refresh after saving; child windows could not be closed; clicking Settings flashed a loading overlay.

---

## 2026-09-12 ~ 09-14

### Added

- **Settings became a separate window**; new **file associations (default app)** and **window zoom** settings.
- A unified **bottom status bar** for reading / editing components (outline, search, export, read aloud, font size, reading progress).
- **Precise editing tools** `replace_in_file` / `multi_replace` with a **diff preview** in the tool result.
- **Mind maps** keep their view after saving, plus talk / presentation modes; **PDF preview**; **document panel with PPT**; **offline map package (MBTiles)**.
- **The swarm merged into the Home chat modes**: the standalone module and `.swarm` plan files were removed and members are Agent presets.
- **The MCP runtime moved into the main process**, with the renderer delegating over IPC.

### Improved

- Source directory layering and the `@` alias; synchronous content across file windows; fixed maths (MathJax) rendering.

### Fixed

- The settings window polluted the main window's navigation; Leaflet map interactions misbehaved.

---

## 2026-09-07 ~ 09-11

### Added

- **LAN sharing**: phones and other computers reach the chat interface in a browser and can share knowledge base folders.
- **Browser agent**: automatic AI tab recycling; bookmark import / export (Netscape HTML compatible).
- **Skill store**, **paged session logs**, **left/right MCP settings layout**, **image viewer navigation within the folder**.

### Improved

- Agent CLI directory structure and scaffold tabs; single-page knowledge base Q&A with multiple model providers; file tree and first-screen startup performance; unified global context-menu styling.

### Fixed

- The mind map view reset after saving; Excalidraw collaborator cursors crashed the editor; the "modified" badge in the knowledge base file view did not trigger.

---

## 2026-09-04 ~ 09-06

### Added

- **Per-tool switches** (Agent presets / swarm members); streamed agent tool arguments, a `<think>` reasoning block and Markdown in the question dialog.
- **Local ONNX TTS** (Kokoro / Piper) and a **TTS / ASR settings split**; FunASR local and streaming punctuation.
- **Python-lite sandbox**, **PTC (Code Mode)**, **multi-workspace support**, **new workflow nodes**.
- **RAG strategy improvements**: agentic evidence reranking, a hybrid strategy, faster community / ontology recall, batch-test prewarming panel.
- Show / hide todos with a week view; **Data Canvas** form entry.

### Fixed

- Unified Mermaid rendering (viewer dialog, PPT, height limit); structured JSON output for file collection.

---

## 2026-08-26 ~ 08-31

### Added

- **LAN collaborative file editing** (Yjs CRDT: code editor + Excalidraw whiteboard, member cursors and edit permissions).
- **Remote file sharing**: shared folders appear in the file tree as a read-only "remote workspace".
- **Multiple custom LLM providers**; **Word / PDF export with images** (MHTML); exam tab and question bank paging.

### Improved

- Startup first-screen and file tree performance; child window system-menu titles; knowledge base auto-preparation and extra configuration options.

---

## 2026-08-18 ~ 08-24

### Added

- **Local ASR** (ONNX Whisper) with punctuation verification; **media player**; **skills merged into Settings** (Codex skill format compatible).
- **Swarm**: automatic round count, event timeline, manager agent, per-swarm run isolation, capability node graph.
- **Workflow**: new nodes (M1 / M2) and test result display.

### Improved

- Mini Python sandbox; multiple workspace roots; file tree expansion persisted; Data Canvas dual mode on Home.

---

## 2026-08-12 ~ 08-17

### Added

- **AI services moved into the main process** (all model requests go through it); **MCP moved into the main process**; swarm MCP control.
- **Agentic RAG**; SciPy support in the Python sandbox; skill management merged into Settings; early skill store.
- Map GeoJSON charts and dashboard mode; tool-call cards collapsed by default and showing arguments live.

### Fixed

- Home chat title generation, blank step indicator, swarm plan switching isolation and several other issues.

---

## 2026-08-04 ~ 08-08

### Added

- **Visual editing** (block editing) with formula support; **AI change diffs** in the edit view; workflow test result display; merging several tables in information collection.

### Improved

- dev / prod coexistence; swarm member selection and run status display.

---

## 2026-08-01

### Added

- Multi-agent **swarm types** (generic / control), situation map and equipment, plan (planning) management.

> Note: the "swarm control / situation map / equipment and plans" capabilities were later split off into the separate **SwarmPlanner** software.

---

## 2026-07-20 ~ 07-21

### Added

- Offline map (MBTiles) prototype; plans (planning) management prototype.

> Note: both were later moved out into the separate **SwarmPlanner** software together with the swarm planning capabilities.


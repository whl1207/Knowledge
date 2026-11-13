# Changelog

> Feature change log of AI-KM; the in-app **Settings → Help → Changelog** page shows the same file.
> Chinese version: [CHANGELOG.md](CHANGELOG.md)
> Convention: user-visible changes are appended to the **top-most date section**; basic Markdown only (`##` date, `###` category, `-` entry, inline code).
> **Keep it short**: one sentence per entry — "what changed + impact"; no implementation details, code paths, previous-implementation comparisons or examples; merge similar changes into one entry; **prefer ≤ 15 entries per day (20 max)**.

---

## 2026-11-13

### Fixed

- **Opening a skill file no longer fails with ENOENT**: reading a relative file inside a skill directory now records the resolved absolute path, so the step’s Open button goes straight to the skill file.

---

## 2026-11-12

### Improved

- **New “Deliverables” capability**: agents can declare final files with `present`; after the reply finishes, deliverable cards support preview/open, and the session log records the declarations.
- **Messages sent while running now queue first**: Enter only adds to the pending queue; click “Steer” to deliver at the next step. Per-row and “steer all” actions are available, with no automatic insertion.
- **Automatic repair of XML tool calls**: when a model writes `<tool_call><function=…>` as plain text, the system extracts the tool name and arguments and continues instead of ending the loop because no structured tool call was returned.

---

## 2026-11-11

### Improved

- **ask_user no longer submits before all questions are answered**: the primary button goes to the next question / unanswered ones, and only submits when everything is answered; “Submit skipped” remains available for an explicit skip.

---

## 2026-11-10

### Added

- **Agent presets now use capability bundles with per-tool overrides**: Read-only / Coding / Knowledge Q&A / Office / Browser / All tools fill the tool set in one click, new tools join selected bundles automatically, and every tool inside each group remains individually toggleable.
- **Automatic tool gating**: when vision, sandbox, knowledge base or MCP conditions are not met, the settings page marks the tool “auto” and runtime hides it, so the UI no longer promises tools that cannot run.
- **Tool-set changes are written to the session log**: Settings → Agents → Logs shows tools added/removed each turn, including the PTC run_code collapse.
- **Tool set is frozen for the current turn**: changing settings or plugins mid-run no longer changes this turn’s tool schema; it applies from the next turn.
- **Default timeout for tools without one**: a plugin or new tool that forgets to declare a timeout can no longer hang forever (10 minutes by default).

### Fixed

- **Settings no longer overwrite each other across windows**: with several windows open, settings, model sources and newly added agents are not reset by another window’s older state.
- **Built-in preset tool toggles no longer revert**: tools you unchecked are not added back after a restart.
- **New agents are no longer lost in folder mode**: a newly created agent no longer disappears when Settings is reopened.
- **Image-read failures no longer abort the whole run**: when the model cannot take images the image is skipped and the task continues instead of stopping.
- **Closing a question suspends it instead of stopping**: Close / “Answer later” moves the question into “Needs me”; only “Abort” stops the agent.
- **Plugin panel title is centred again**: fixed the title offset in overlay mode.
- **Expanded agent tools show the real result**: file reads show the content, commands show the output, searches show file or hit lists; the top and bottom panes are no longer identical.
- **Agent tool errors no longer abort the whole run**: a plugin approval failure, a result that cannot be serialized, or a tool’s own error only fails that call, so the agent can continue or choose another path.
- **Large knowledge bases no longer freeze or crash on ask**: the stalls and crashes on large retrievals are fixed, with less repeated work.
- **Closing the settings window by the system now saves**: closing via Alt+F4 or similar no longer drops the last edit.

### Removed

- **MDS / MDS(M) / PCA removed from retrieval methods**: they are dimensionality-reduction/visualization methods, not retrieval strategies; only CS / CS(M) remain, and older knowledge bases fall back to CS.
- **Unused t-SNE / UMAP dimensionality settings removed**: fewer dead settings and a smaller bundle.

### Improved

- **Merged cosine (CS(M)) now actually uses question vectors**: it blends related questions, so CS(M) is no longer identical to plain CS.
- **Knowledge-base retrieval and question lists are smoother**: question indexes and answer text are cached and reused, making filtering and retrieval faster.

## 2026-11-07

### Added

- **Learning is now part of the Knowledge Base module**: the left nav gains Overview / Map / Review / Mistakes / Exam, Learning shares the module status bar, and the old top-level Learning entry is gone.
- **The knowledge overview is now a four-ring graph**: files / slices / entities / questions show 50–80 nodes, labels are hidden for hover tooltips, nodes are placed clockwise by similarity, and more relevant nodes are larger.
- **The QA graph and evidence now share one panel**: after an answer the graph moves to the right, matching nodes are highlighted and others dimmed; the panel switches between Graph / Sources / Entities / Questions, and clicking a node shows its Markdown in place instead of navigating away.
- **Knowledge-base settings moved into the toolbar**: Version Management, Strategies and Other Settings are toolbar buttons, the settings page no longer has its own sidebar, and “Settings” is removed from the module nav.
- **The ontology node panel was redesigned**: tabs are gone; a Markdown description and property grid are shown together, related slices and nodes expand below, selected-node details float above the graph, and the legend moved to the bottom-left.
- **Knowledge bases are archived per folder**: newly saved .kb files go to `知识库/<name>/`, learning records sit beside them, and the toolbar offers “Organize KB folders”.
- **A “Learning tutor” QA mode**: the composer switches between normal Q&A and tutor mode, and Review / Practice / Exam add an “Ask” action that prefills the question in QA.

### Fixed

- **An unreachable embedding service no longer crashes the whole module**: retrieval failure is reported in the answer area as “Retrieval failed” instead of triggering “Extension failed”.
- **A blank placeholder appeared below the QA composer**: the empty file/slice container no longer takes up half the height.
- **The knowledge overview no longer treats slice count as similarity**: entities are ordered by actual retrieval score, so a hub entity no longer always comes first.

### Improved

- **Voice input could not be stopped on touch screens**: the “Listening…” panel is now tappable as a whole (with a “Finish” hint on the right) — tap it to stop recording and start transcription; clicking it with a mouse works too.
- **The slice panel renders less on first paint**: cards show a plain-text excerpt until they enter the viewport or are clicked, search is debounced, and load-more uses a scroll sentinel.
- **The file panel is easier to search and preview**: search / filter / sort, stable row keys, hover tooltips, a draggable splitter, file metadata, a collapsible summary and a preview skeleton.
- **Sources / Entities / Questions lists are sorted by retrieval score**: all three sort by similarity and are capped by the evidence-count setting.
- **The floating mic is friendlier to touch**: the drag threshold is relaxed for touch, so a slight finger wobble is no longer taken as a drag.

## 2026-11-06

### Added

- **Plugins can save rendered output as temp files**: `ctx.files.saveTempFile({ name, mime, dataUrl | base64 })` returns an absolute path for the agent’s `read_image`; files land in the plugin data dir `plugins-data/<id>/tmp/` (not the plugin folder, so writing them no longer triggers a hot reload) and are pruned automatically; the plugin data dir is now readable/writable through `ctx.fs` too.
- **Plugin API keeps moving toward DSH parity**: native main-half plugins can now use `ctx.get('homePaths')` for the plugin data dir (the same `home` as in the DSH compat layer); a plugin’s `apply` accepts DSH’s `(ctx, config)` signature (second argument optional).
- **A plugin's delegation “calls per hour” limit can now be unlimited**: set the per-hour number to 0 or click ∞ under Settings → Plugins → Permissions to remove the hourly call limit (the concurrency cap still applies); the default remains 20 calls/hour.
- **A plugin's delegation concurrency cap is now 200 (was 3)**: still configured per plugin and defaulting to 1; each slot runs a real session, so raise it only when the plugin and model quotas can take it.
- **Native plugins now receive agent step events**: the UI half’s `ctx.on('agent/step-start' | 'tool/call' | …)` goes through the host’s `aikmDsh` bridge (it used to read only `window.aikmDsh`, which native plugins never had, logging “needs desktop main-process forwarding”); plugin panels can show the model’s step numbers and tool names. Web/mobile still lacks this channel.

### Fixed

- **Plugin structured output got a 400 on LM Studio (plugins only saw LLM_FAILED)**: `ctx.llm.chat/stream` appended the “JSON only” instruction as a trailing system message, but LM Studio’s template requires system to come first; it is now merged into the leading system message (or inserted at the front).
- **Delegated-agent results now report clipped tools**: `ctx.agent.run` returns `deniedTools`, so a plugin can point the user at the file relaxation switch instead of repeating a model-invented failure reason (seen in the travel-expense vision test).
- **DeepSeek's 1M window was treated as 128K, compacting at about 90K tokens**: the source default and model table now resolve to the official 1M, moving the compaction threshold back to about 800K tokens.
- **API Status did not refresh DeepSeek's context window**: it now forces a re-probe like every other source; the Context Window field shows the effective value marked auto / manual, typing a number overrides that source, and clearing it returns to auto.
- **GLM / Kimi / MiMo never probed their context window**: they now probe the OpenAI-compatible `/models` and show a Context Window row in Settings; LM Studio falls back to `/v1/models` when the native endpoint is missing; probes time out (8 s local / 20 s remote) so an unreachable URL no longer leaves Settings spinning; source defaults follow the published sizes (GLM-4.6 200K, Kimi K2 256K).
- **Files with unlisted types now open in the source editor**: text files such as `.mjs` that are not in the file-type table no longer default to the read-only preview; `.mjs`/`.cjs` etc. were also added to the code table, and the preview remains one click away.

## 2026-11-05

### Added

- **Setup guide**: shown once for new installs and for anyone upgrading to this version — language / theme / window mode, workspace, source selection, model setup, then module toggles; progress is resumable, collapsible, reopenable from Settings → General → Basic → Common Actions, and adapts to phone-sized portrait windows.
- **New built-in sources: GLM (Zhipu), Kimi (Moonshot), MiMo (Xiaomi)**: all use OpenAI-compatible endpoints with the URL prefilled, and Test connection fetches the model list; the source list is grouped into Local / Cloud in Settings.
- **Provider sites on the model source page**: each source shows where to download the local app or get an API key, shared with the setup guide.
- **One-click backup / restore on the Data page**: Settings → General → Data → Backup all writes all config plus every chat into one JSON file, and Restore overwrites config while merging chats by id; it also accepts the config exports and chat exports produced earlier.
- **“Check for updates” button**: Settings → General → Basic → Common Actions now checks the latest GitHub Release against the current version; when a newer one exists it lists the packages for this platform (Windows Setup / Portable, macOS dmg, Linux AppImage / deb) and downloads them through the system browser, or opens the release page; when already current it just reports the version.
- **Settings search**: a search box at the top of the settings sidebar matches category and page names (e.g. “Models” lists every source and credential page under it); clicking a result jumps straight there.
- **Automatic snapshot before a full restore**: before overwriting, the current config and chats are written to `backups/ai-km-pre-restore-*.json` in the data folder, and the result message shows the path, so picking the wrong file is recoverable.
- **Setup entry when no model is configured**: the Home composer shows a hint with a “Set up a model” button until a source is configured, instead of only failing with “AI service not connected” on send.
- **One-click diagnostics**: Settings → General → Basic → Common Actions → Diagnostics copies version / platform / data folder / configured sources / workspace and preset counts; when the clipboard is unavailable the text opens in a dialog instead.
- **Startup update reminder**: checks GitHub at most once a day and, unless the version was skipped, points to where to download it; the update dialog also previews the first lines of the release notes.

### Removed

- **Removed the “Legacy chats” import**: Settings → General → Data no longer offers the old AI-KM chat JSON import, and the related compatibility code is gone; use Backup all / Restore and the Chats row instead.

### Fixed

- **The info icon next to the File Behavior title was invisible**: Font Awesome 5 picks glyphs by weight, and forcing weight 400 landed on a Regular face without that glyph; it now uses 900 and renders (tooltip unchanged).

- **Config backup now covers the security policy and preset location**: Settings → General → Data → Export all now includes the security policy (read-only / workspace-write / full access) and the preset folder, so restoring no longer silently falls back to the default level and default folder.
- **Config backup no longer carries runtime state**: source online status, current view / sort order / main panel are skipped on export and also ignored when importing older backups.
- **Preset import is written to disk**: when presets live in a folder, importing also writes `.agent` files, so "import succeeded but the list did not change" no longer happens.

### Improved

- **Data page layout**: Model Usage now sits at the top; Config Backup is back in the inventory (alongside Chats / Agent presets / MCP servers / Session logs), and the duplicate session-log folder button was removed.
- **Leaner setup guide**: source selection has its own page grouped by Local / Cloud / Custom gateway, and model setup only fills that source's endpoint or key plus the model name (side by side).

## 2026-11-04

### Added

- **Plugins can register file viewers; File Behavior uses responsive Grid cards**: plugins declare `declares.fileViewers` and call `ctx.fileViewers.register` to handle custom formats; Settings → General → Files (formerly Associations) manages in-app views and system default apps in responsive grid cards (one column on narrow windows) — Markdown lists Browse / Source / Visual / Mind Map / Presentation, Word lists Office / Browse / Mind Map, and plugin views are marked by source and can be set as default.
- **New “Trajectory” tab in the Home right dock**: modelled on the DSH Trajectory view, it groups records by turn — user messages, replies, reasoning, tool calls and compaction — with tool / token / cache / elapsed summaries; opened manually as a new tab and read-only.
- **Office MCP can convert legacy .doc to .docx**: new `convert_doc_to_docx` uses Microsoft Word COM on Windows and falls back to LibreOffice; if neither is available it fails instead of producing a formatting-lossy text-only .docx. The default output is a same-named .docx next to the source, ready for `open_document`.
- **Markdown in Learning questions / answers / mistake book**: question stems, answer explanations (including slice content in “summarize this slice”), mistake details and reference slices, exam stems / options / reference answers are rendered as Markdown.
- **Editable context window**: the Context Window field under Settings → Models → source now accepts a manual override (clear it to return to auto); custom / GPUStack sources also try reading context length from `/v1/models` and similar endpoints.
- **No workspace path for workspace-less agents**: when a chat explicitly uses no workspace, the system prompt no longer injects the default workspace path and the tool cwd does not fall back to it.

### Fixed

- **Office native views no longer cover Settings / view menus in single-window mode**: the WebContentsView is hidden while a settings overlay or view menu is open and restored afterwards; PowerPoint keeps only the Office editor view.
- **File Behavior gained a separate default column**: File type / Extension / Available views / In-app default / System default each have their own column, and the selects no longer carry extra margins.

## 2026-11-03

### Added

- **Themes can be created, deleted and restored to defaults**: the theme picker is an equal-width grid with “Add Theme” (name it and clone the current colours), per-theme delete, and “Restore Defaults” (removes all custom themes and returns to Light Blue); the old single “Custom” option is migrated to a named custom theme, and Warm Tones / Vintage Yellow are removed from the built-in list.
- **The fullscreen button next to Navbar Layout moved to Common Actions**: fullscreen / exit fullscreen now sits with Developer Tools, Reset etc.
- **New “Needs me” inbox in the nav bar**: everything waiting on you — agent questions, plans awaiting approval — is collected in an entry just left of Settings (with a count badge, toggled by `Alt+I`); answer or approve right there, and there is no “mark as read” — nothing leaves the list until it is resolved.
- **Agents can report their run status**: a new `report_run` tool (progress / waiting / ready / blocked / failed / dropped); “blocked”, “failed” and “ready for review” show up in the “Needs me” panel, while the other states are recorded without interrupting you.
- **The “Needs me” button can be hidden**: it now sits with the other module switches under Settings → General → Basic → Navigation & Modules; once hidden the navbar no longer shows it (and `Alt+I` is disabled too).
- **Batch re-runs no longer queue behind automatic work**: one extra concurrency slot is reserved for re-runs you trigger yourself, so clicking “re-run this row” starts immediately even when the configured concurrency is fully used (the total goes +1 for a moment); automatic work can never take that slot.
- **New Activity section in the “Needs me” panel**: on-screen toasts are also collected there (a small blue dot marks unread ones; review and clear them at will), so a missed message no longer needs to be triggered again.
- **New Todos and Plan tabs in the right dock**: when the agent produces content via `update_todo` / `update_plan`, the matching tab is created and the dock opens automatically; the old todo panel above the composer is removed, so tasks and plans live in the dock.
- **Workspace and File entries on the right dock's new-tab page**: the old “Files” entry is renamed “Workspace” (workspace file tree), and a new “File” button lets the user pick a file and open it as a tab; Branch / Todos / Plan are singletons (their entry disappears once the tab exists), and all entry buttons use an equal-width grid.
- **New chats default to no workspace**: the workspace panel now has a “No workspace” option next to “Follow global default”; when selected the agent has no working directory and Files no longer falls back to the global default.
- **New “Browser Extras” group in preset Tools and Tool Management**: 25 advanced browser tools (claim tab, tab management, drag, wheel, paste, downloads, Playbooks, site learnings, page eval, etc.) are collected in a collapsed group for advanced users, instead of being mixed into the common browser cards; the two browser groups now map one-to-one to the 40 browser functions of the Web Agent MCP service.
- **Compact context manually from the chat right-click menu**: right-click in the home chat window and choose “Compact context” to summarize old turns immediately (same logic as automatic pre-send compaction, visible messages unchanged), with a before/after token estimate.
- **Agent-preset edits are written back to `.agent` files in real time**: changes are flushed within 200ms, and again before the settings page/app closes, so the `.agent` file in the preset folder can be handed to someone else and imported directly.
- **Settings → Agent → Management shows live system-prompt usage in the General panel**: the token estimate follows the current system prompt, tools, skills and knowledge-base config and updates as you change them.
- **Images can be inserted into and replaced in Word documents**: new `list_images` (image list with display sizes), `insert_image` (document end / before or after a block / inside a table cell or nested table, PNG/JPEG/GIF/BMP/WebP etc., max width 15.9cm by default) and `replace_image` (replace by index while keeping the original display size and layout by default).

### Fixed

- **The default model source could revert after reload**: when the standalone Settings window saves, the AI config is now broadcast with `settings-config-changed` and applied directly in the main window's memory, so the main window can no longer overwrite the new default with its stale copy.
- **New agent presets no longer share the same name**: creating / duplicating a preset now generates a unique name such as “New Agent 2 / New Agent 3”, so the `.agent` files in the folder do not overwrite each other.
- **Knowledge-processing question extraction showed “complete” after failures**: per-slice reasoning failures are no longer swallowed; failures are summarized with a toast, progress is kept, and the resume point moves back to the first failed slice, so “status says complete but the question bank is empty” no longer happens; an all-embedding failure also reports an error.
- **Knowledge-bank answers showed “B” instead of text**: `extraAnswer` now always stores the textual answer, `answerChoices` stores the correct option labels, and `choiceMap` stores the option bodies; old data is migrated on load, the Learning module still grades deterministically by label, while the KB / ontology / question details display the answer text.
- **Embedding fallback failed hard when its source was unreachable**: when the LM Studio / custom fallback embedding endpoint is unreachable, the current chat source’s embedding endpoint is tried before giving up; model-list failures also raise a visible message instead of only a console error.
- **Browser automation is off by default for new agents**: the Tools tab now has “Disable all / Enable all”, and the tool count reflects the actual enabled set; “Disable all” clears the set directly (including browser extension tools that have no card), so it no longer ends at 17 after showing 57 at full enable.
- **A question waiting for you disappeared after the UI reloaded**: pending questions and plan reviews are now restored from the agent state when the renderer reloads or a window is reopened, instead of surviving only in the original chat dialog.
- **Right-dock width could not be changed by dragging**: the open/close animation wrapper broke the “chat area + dock” room measurement and clamped dragging to the minimum width; it now walks up to the real container, and the handle sits inside the dock so the animation no longer clips it.
- **Chats created from a workspace group’s “+” did not belong to that workspace**: the new chat now stores that workspace and clears “No workspace”, and defaults to Agent mode.
- **The compaction card's before/after token numbers did not match**: both now use the whole-request basis, the replaced old-message size is shown separately, and compaction automatically retries with a more aggressive range when the gain is too small.
- **Word formatting inside a paragraph was normalized when a match crossed runs**: only the matched characters are replaced now, and untouched runs keep their bold / italic / font size and other formatting (the replacement text takes the formatting of the run where the match starts); the whole-paragraph tool now warns that it loses inline formatting.

### Improved

- **Settings → General → Basic: themes are now equal-width grid cards**: no more dropdown; every theme card has the same height and a colour preview, and Custom Title / Zoom moved to the bottom in the order Zoom → Custom Title → Portable Config.
- **Adding a theme now opens a dialog with colour pickers and a live preview**: choose the six colours in the dialog, preview them immediately and create the theme on confirm; the old six colour cards under Text Alignment are gone.
- **Removed the empty-navbar notice switch**: the notice is now always shown; the built-in themes Minimal Gray, Dark Purple, Milk Tea Color and Ice Blue were also removed.
- **Removed the Knowledge Management sub-panel from Settings → General → Basic**: views are switched from Knowledge Management’s own toolbar, so the settings page no longer repeats those switches (Navigation & Modules now only holds navbar entry toggles).
- **The two Work Step Display options now live in the Software UI block**: instead of their own settings card, the detail level and collapse timing sit with the other interface options (the step-level icon in the chat header still works).
- **Settings in single-window mode reuses the top navbar**: the settings page no longer covers the navbar or shows its own “Settings” title bar; click the ⚙️ in the navbar to open it and click again to close (switching modules closes it too).
- **Toasts no longer pop up in a corner**: a message now slides out just left of the “Needs me” button, stays a few seconds and folds back into it, while a copy is kept in the panel\u2019s Activity list.
- **The right dock now opens and closes with the same animation as the left chat list**: width slide plus fade, with content keeping its own width so it does not reflow; closing the last tab automatically closes the dock.
- **The agent-picker chip in the composer has a distinct icon**: it now uses `fa-id-badge` instead of the `fa-user-circle` icon used by Agent mode.
- **Grouping the chat list by workspace**: chats with no workspace are placed at the top and the “No workspace” group title is omitted.

- **Context compaction now follows the DSH mechanism**: for windows ≥256K the trigger is the smaller of “window × 0.8” and “window − output reserve − 64K headroom”, with the retained tail at `(window − output reserve) × 16%`; windows of 8K / 32K / 64K / 128K fall back to the classic 80% rule (64K absolute headroom is too large for them), one extra compaction runs when pressure is still above the threshold (at most once), and tool-result pruning now applies to subsequent requests.
- **Small-window compaction guards**: if the system prompt plus tool schemas already exceed the compaction threshold, automatic summarization is skipped with a warning (common on 8K windows, where compacting history cannot help), and after a compaction that is still above the threshold the next automatic attempt is throttled for 60 seconds.
- **Word table replacement can be scoped and guarded**: `find_and_replace_text` now accepts `blockIndex` / `row` / `col` (only the given table cell), `dryRun` (count only) and `expectedMatches` (abort if the hit count differs), so identical words elsewhere are not replaced by accident.
- **Large Word table cells can be edited paragraph by paragraph**: the new `read_table` returns each cell's paragraph numbers and text, and `find_and_replace_text` accepts `paragraph` to change only paragraph N of a cell (e.g. a section heading and its body separately) while other paragraphs, the table structure and formatting stay untouched.
- **Word nested tables can be read and edited**: `read_table` recursively returns tables nested inside a cell with `cell.path`, and `find_and_replace_text` accepts `cellPath` (optionally with `paragraph`) to change one nested cell/paragraph while the outer cell, other nested tables and text outside stay untouched.
- **Skill / Agent / Plugin Management footers now share one line**: count + path + action icons on a single row; when the left pane narrows (≤300px) the path collapses to a folder icon with the full path in its tooltip, matching across all three panels.

## 2026-11-02

### Added

- **Skills can be organized in multi-level category folders**: skills nested two or three levels deep are discovered and grouped by folder.
- **Plugin Management supports multi-level category folders**: grouped by folder with collapsible groups, group All / None, and the same cards and search as Skill Management.
- **Skill Management and preset Skill tabs group by folder**: collapsible group headers show the enabled count and offer group All / None (All / None for preset selection).
- **Run info in the top-right corner**: total turns / steps for this chat, tokens used (with a cache hit ratio when the provider reports it) and a smaller context ring, using Font Awesome 5 icons.
- **The agent picker can be searched**: type a name to filter, matching the model picker.
- **Input-bar selectors are now custom panels**: chat mode / retrieval strategy / swarm run mode match the workspace and model chips and collapse to icons on narrow windows.
- **The chat list right-click menu has submenus**: Order / Sort / View move into submenus while Archive and Delete stay on the first level.

### Improved

- **Model selection moved to the bottom-left of the input bar**: same style and height as the workspace and mode controls.
- **Skill Management hides the right pane until a skill is opened**: the list fills the width, and the file tree plus editor appear only after clicking a skill (click again or use × to close).
- **Plugin Management keeps its detail pane closed by default**: clicking a plugin opens it, and clicking again or × closes it; the card list fills the width while nothing is selected, matching Skill Management.
- **Skill cards and the upload button are unified**: cards show version / file count / toggle, and the attach button uses the same 29px icon style.
- **The workspace panel dropped its duplicated explanation**, which now lives in the chip's tooltip.
- **The Skill Management search box has room above it and the right edge is no longer clipped**; the model panel's refresh button is more subtle.
- **The "Set as default" button in LLM settings** now matches the "Default" tag height and no longer stretches the title row.

### Fixed

- **The right side of the Skill Management panel was cut off**: width overflow is fixed, so the list and cards show in full.
- **Input-bar buttons did not collapse after opening or widening the right sidebar**: folding is now based on the input card's actual available width, so buttons become icons when space runs out.
- **The right sidebar's content was clipped after dragging it fully left**: its maximum width is now computed from the available space, always leaving room for the chat area.
- **The Plugin Designer looked for existing plugins in the wrong place**: `plugin_dev_host` now returns each plugin's real folder (including category subfolders) and warns against guessing "plugins/<id>"; `plugin_dev_check` also resolves a plugin id inside category folders.

## 2026-11-01

### Added

- **Right-click a spot in the map view to create a file there**: the new Markdown stores the clicked coordinates and appears on the map as a marker at once, and the same menu can copy the coordinates.

### Improved

- **Multi-edit shows "N chars · M replacements generated" while streaming**: progress is visible as with file writes, instead of a raw `{"replacements":` argument fragment.
- **Markdown tabs in the right sidebar can switch views**: click the tab icon to move between Browse / Source / Visual / Mind Map / Presentation (clicking it did nothing before).
- **Step cards**: the open-file icon moved to the left of the status icon so every status icon lines up on the far right, and a running compaction now shows "N chars summarized".
- **Search / find steps show the keyword and hit count in the summary**: e.g. `"TODO" · 3 files · 12 matches`, so standard mode makes it clear what was searched and what it found.

### Fixed

- **The context-usage ring at the top did not drop after compaction**: it now recalculates usage from the summary plus the kept recent turns the moment compaction finishes instead of keeping the pre-compaction number, and the compaction card also shows the size after compaction.
- **Multi-edit stayed on "Waiting…" while streaming**: it now reports the generated character count (old_string included) and the replacement count, and falls back to "generating… (N chars received)" before those fields appear.

## 2026-10-31

### Added

- **Chats can be archived**: right-click a chat to archive / unarchive it and right-click the empty list area to "Show archived chats"; archiving only hides a chat, and toggling the filter never changes the saved order.
- **Four work-step display levels (compact / standard / detailed / verbose)** with a separate collapse timing (on completion / on the next message), available from the chat right-click menu or Settings → General → Basic; a finished turn can be expanded or collapsed with one click.
- **Background commands in the home header**: running background shell jobs (including foreground commands that timed out and were moved to the background) show their tail output and can be stopped in one click.
- **Three new tools**: `read_image` (hand a local image to the model), `working_directory` (switch the session's working directory, inside the workspace only) and `job_list` (list background jobs).
- **Agents now get a clock reading**: every 10 minutes a "current time + time zone + time since the last exchange" note is injected, so dates and time zones are no longer guessed.

### Improved

- **Command execution**: a non-zero exit is a result rather than a failure (output carries `[exit code: N]`), timeouts and cancels kill the whole process tree, oversized output keeps its tail while the full text is spilled to a file, and PowerShell plus background runs are supported.
- **Reading, writing and searching files**: `read_file` pages by line with line numbers, `write_file` verifies before and after writing, `replace_in_file` / `multi_replace` roll the whole batch back on failure, `glob` is new, and `search_files` groups hits by file and is case-sensitive by default.
- **Tool cards fit in one line**: collapsed rows show title · summary · size / diff · duration, failed commands get a dot-and-exit-code pill, running rows sweep, and written files and fetched links can be opened directly.
- **Compaction costs less**: oversized tool results are pruned first and a summary is written only when still needed, summaries became structured checkpoints, and overflow recovery is more decisive.
- **Live guidance lands in the timeline**: it no longer appears at the bottom of the conversation but where it took effect, styled like a tool row.
- **The model panel now opens with a search box**: typing filters by model or source name with highlighted matches, Enter picks the first match and Esc closes it; the panel is narrower and the header button shows only the current model name.
- **Max tokens default 16000 → 32768, upper limit opened to 262144**: each request is clamped to the selected model's known output limit (e.g. `gpt-4o` 16384, `claude-3-haiku` 4096) and auto-downgrades once if the server still rejects it, so long answers and agent file writes are no longer cut off as often.

### Fixed

- **Two error icons appeared in the input bar when the model could not be reached**: they are merged into one and a single click clears both.
- **An "overlapping ranges" rejection for multi-edit did not say what to change**: it now names the entries and the shared text and suggests how to fix it.
- **Queued guidance still waited for the whole turn**: it is now delivered while tools are running and applies on the next step.

## 2026-10-30

### Improved

- **The home "model type" and "model" dropdowns are merged into one model panel**: clicking the model button picks a source and model in one step from every enabled source, clicking a source name switches to it and probes its models, and preset-follows-default chats can return to the global model from the panel.

## 2026-10-28

### Fixed

- **Agent / workflow chats often kept their generic title**: the title is now refined concurrently right after the first message is sent instead of waiting for the whole run, so it updates within seconds.
- **Voice dictation reported "no input field" after clicking blank space in the home input card**: clicking the card's padding or the empty part of its control row now puts the caret back in the composer (buttons and dropdowns behave as before), so dictated text lands in the input instead of only the clipboard.

### Improved

- **The workspace picker is hidden in Normal / Knowledge Base / Workflow modes on home**: those modes do not use the chat's own workspace (workflow nodes use the global default folder), so the picker now shows only in Agent / Skill modes.

## 2026-10-27

### Added

- **Skill / Agent management left navigation now mirrors Plugins → Manage**: an install button plus refresh / rescan / open folder / select folder / restore default, a search box below and a footer with the count and folder path. Skills can be installed by picking a skill folder (copied into the skills folder; collisions ask before replacing) and agents by picking one or more `.agent` files. The settings item formerly called “Presets” is now “Manage”.
- **The built-in MCP service “Preset Management” was renamed “Agent Design Reference”** (the stored display name is corrected automatically; the service id is unchanged).
- **A built-in “Agent Designer” agent** (renamed from “Preset Designer”): describe what you need in chat and it creates or adjusts an Agent preset — every write is dry-run validated first (unknown fields, unknown tool names, duplicate names, out-of-range numbers are all reported), and built-in presets can never be overwritten; the companion MCP service `builtin-agent-preset` (9 tools: schema / capability map / example / storage info / list / get / validate / write / delete) can also be bound to other agents and workflow nodes.
- **Agent Designer now writes files only**: it no longer goes through `preset_write` — it writes the `.agent` into the preset folder with `write_file`, then loads and self-checks with `preset_reload` (reporting skipped files and field errors); the MCP service is used for reading the spec and current state only, and existing designer prompts are upgraded automatically.
- **Agent Designer can now write files directly**: besides `preset_write` it has file read/write tools, so when an MCP call times out it can write the `.agent` into the preset folder and call the new `preset_reload` to rescan and self-check (reporting skipped files and field problems); the built-in service timeout was also raised from 60 s to 180 s.
- **Fixed occasional 60-second timeouts in `preset_list` / `preset_validate`**: both used to rescan the skill library and workspace on every call, which blocked the main process on large folders; the skill list now comes from the already-loaded cache and the workspace scan degrades after 4 s (only losing a few “unknown skill / unknown .kb” warnings).
- **A built-in “Skill Designer” agent**: tell it what the skill should do, how users will trigger it and whether it needs scripts or templates, and it writes the skill folder and self-checks before handing over; the companion MCP service `builtin-skill-dev` (7 tools: skills folder / anatomy / writing guide / hard rules / templates / troubleshooting / `skill_dev_check`) validates frontmatter, folder name, `$` triggering, body size and every referenced resource.
- **The three “designer” presets were renamed and moved after the other built-ins**: Plugin Dev Agent → **Plugin Designer**, Preset Designer → **Agent Designer**, plus the new **Skill Designer**; the settings sidebar now lists **Skills → Agents → Plugins**.
- **Skills and Agent presets now have a default storage location**: skills default to the application data folder → `skills`, presets to `agent-presets` (one `.agent` file per preset), so they work out of the box without picking a folder first; both can still be pointed at another folder and restored to the default (existing presets are migrated into the default folder — only an empty folder is written, never overwriting files).
- **Settings → Agents → Presets has a storage panel**: change folder, rescan, open in Explorer, switch back to local storage, or restore the default location; the path is persisted and built-in presets are never written there.
- **Word preview / reading now supports legacy `.doc`**: file browsing, chat attachments, knowledge-base normalization and the agent's `read_file` can read Word 97-2003 documents directly (body text and tables become Markdown; complex layout is not preserved), no need to save as `.docx` first.
- **Settings → Models → Sources now shows how many tokens each source has consumed, with a daily usage chart**: every source row carries its own cumulative usage and the “Usage of this source” card breaks it down into total / today / input / output plus a daily bar chart for the last 7, 30, 90 days or all time.
- **A new “Model Usage” section in Settings → General → Data**: it shows the combined total of all sources — all time, today, input / output and request count — with a per-day chart (only requests recorded since this version, no backfill).

### Fixed

- **Office editor AI-assistant icons rendered as squares and the AI panel had no title**: Excel's content security policy blocked the icon font, so the icons are now inline and the panel title is restored; the AI entry points and title display correctly in Word, Excel and PowerPoint.
- **Switching views in a Word window blanked the embedded editor, and PPTX showed a one-item view menu**: the other views now expand horizontally in the title bar (animated) instead of hiding the editor, and single-view files no longer show the switcher.
- **The app crashed when choosing a huge workspace such as the D: drive**: the file tree now reads a folder only when it is expanded, so workspace size no longer matters, and the search box looks up file names across the whole workspace with result and time limits.

## 2026-10-26

### Fixed

- **Linux arm64 builds opened with only a process and no window**: fixed the main-process error caused by loading the global-hotkey native dependency during startup; a load failure now only falls back to the single-press shortcut.
- **Clicking a custom source under Settings → Models → Sources silently made it the default source**: clicking now only views/edits that source, the default still changes via “Set as default”, and edits no longer leak into another source.
- **GPUStack showed offline and fetched no models in Settings**: the connection test dropped the API key stored in the credential vault (the custom source passed it), and now uses the same full configuration as custom sources.

## 2026-10-21

### Added

- **Browser Agent now works from page snapshots and element refs**: read the interactive snapshot with `ref`s, then click/fill using real mouse and keyboard input (keys, hover, select), with explicit reasons when an element is hidden, occluded or disabled.
- **New browser wait conditions**: wait for an element to appear/be visible, text to contain, URL to match, load to finish or the network to go idle instead of sleeping blindly.
- **Pause and take over AI browsing**: pause, resume or take over AI tabs from the toolbar; taking over turns AI tabs into normal tabs and rejects that session's browser tools.
- **Download list and browsing history**: open, reveal or clear downloads in the browser shell, and browse/reopen history plus recently closed tabs from the side panel.
- **Downloads and history moved to the top toolbar**: the bookmarks / downloads / history icons can be shown or hidden under “Browser settings → Icons”; the side panel no longer duplicates them.
- **Scripted multi-step browsing (`browser_run`)**: one script can navigate, snapshot, click, fill, wait and extract in a single round, cutting model round-trips.
- **Single-window mode embeds the browser in the main window**: the globe icon (now after the four built-in modules and before plugins, in left/bottom/top nav) opens the browser in the main content area; multi-window mode still opens a separate window.
- **History search now matches the bookmarks search**: same rounded box, search icon and one-click clear.
- **The browser nav icon shows an active state**: highlighted like other modules when the embedded browser is open (single-window) or the standalone browser window is open (multi-window).
- **Browser settings page redesigned**: left section nav (General / Behavior / Learnings / Privacy / Cache / About) plus content cards in a settings tab; changes apply instantly and it no longer lives in the narrow side panel.
- **Help → Design references now includes ego-lite**: observation/action/session semantics, code rounds and the settings-tab pattern.
- **Settings now covers behavior, privacy and logins**: page budget, interactive-only snapshot default and download folder; cookie/site-data overview and clearing; import logins from local Chrome / Edge (Windows, v10/v11; new App-Bound v20 cookies are skipped with a note).
- **Site learnings**: `browser_learning_save/list/get/delete` store reusable per-site notes as Markdown (no passwords/cookies), viewable/removable in settings; read them before a repeat site task.
- **Browser scripts inside PTC**: `run_code` programs get a `browser.*` helper API (goto/snapshot/click/fill/press/waitFor/extract/tabs/finish…), sharing the same tools as `browser_run`.
- **Cross-origin iframe (OOPIF) support**: snapshots scan interactive nodes inside cross-origin frames and assign refs; click/fill/press/hover/select run via frame DOM + coordinate offsets (upload not supported yet).
- **Viewport-accurate snapshots**: `browser_snapshot scope="viewport"` filters out off-screen nodes using DOMSnapshot layout bounds; `subtree` targets one ref's subtree.
- **External MCP gets its own browser partition**: `external:*` owners use `persist:browser-agent-external`, isolated from the in-app login state; download and site-data clearing cover both partitions.
- **Settings tab stays open when switching tabs**: switching to a page tab only deactivates it; the settings tab stays in the strip, clicking it or ⚙ brings it back, and only its × closes it.
- **Action reliability P0**: actions retry during resolution/actionability for up to 3s (never after input is dispatched); errors distinguish transient/permanent; stale refs first recover via unique locator, then via a fresh snapshot + role/name.
- **File chooser & hand-off**: AI clicks that open a native file chooser are intercepted, and `browser_upload` can select files without a ref; `browser_claim_tab` takes over a user tab after the user chooses “Hand this page to the AI”.
- **New input primitives**: `browser_drag`, `browser_wheel`, and `browser_paste` (text/HTML, restores the clipboard).
- **In-page action cursor**: clicking/filling/hovering/selecting shows a cursor and action label at the point (toggle under Settings → Behavior).
- **Download P0–P1 complete**: `browser_download_wait` (wait for completion/failure, returns id/path/size/MIME) and `browser_download` (cancel/pause/resume/saveAs/delete); action receipts carry a downloadId; download history persists across restarts; risky types (exe/msi/bat/ps1…) are blocked by default and a max file size is configurable; external MCP downloads go to an isolated `external` subfolder; the download panel can pause/resume/cancel directly.
- **Settings fill wide screens**: the 820px content cap was removed, so cards fill the content pane instead of leaving a large blank area on the right.
- **Executable site playbooks**: `browser_playbook_save/list/get/run` store repeatable site flows as scripts using the `browser.*` API. The agent can only save drafts, read, and run approved playbooks; Settings → Playbooks lets the user review code, approve/revoke/delete, and any code change requires re-approval.
- **Download icon shows a live dot**: while downloads are progressing/paused, the toolbar download icon gets an amber pulsing dot and the tooltip shows the active count; it disappears when they finish or are cancelled.
- **Toolbar icon order changed**: bookmarks (tag) → history → downloads → settings; history sits right after the tag icon and before downloads.
- **New `browser_help` guide tool**: one concise, generic Web Agent workflow (quickstart by default; topics actions/waits/tabs/script/files/learnings) for external MCP clients to read before a task; it does not open a browser window.
- **New `browser_list_downloads`**: MCP/agents can inspect download records (name, state, progress, path) without the UI.
- **Settings header removed**: the settings tab no longer shows the redundant “Browser settings / Changes apply instantly” header; it goes straight to the left sections and content.
- **Fixed downloads not recorded in the embedded browser**: the docked browser path skipped attaching the `will-download` listener, so files downloaded while the panel stayed empty; the listener is now attached when the embedded browser opens, and progress/completion show up.
- **Real Electron browser e2e**: `npm run test:browser-e2e` launches real Chromium with a temporary profile and drives a local fixture through navigate → snapshot → fill → click → wait → select → hover → extract → learnings → download → finish, writing JSON results.
- **Stale refs recover automatically**: when a local DOM change invalidates a ref, the browser re-snapshots, matches the element by role+name and retries once.
- **Browser settings now open as a tab**: the ⚙ button opens a “Settings” tab in the tab strip (settings + cache); the side panel only keeps bookmarks / downloads / history.
- **Richer page context menu**: open in system browser, save page (offline HTML), save Markdown to the knowledge base, save as PDF, copy link/image address, open link/image in a new tab, inspect element, navigation and editing items.
- **Empty-bookmarks hint replaced by a placeholder**: no more long guidance block; a single “No bookmarks” placeholder sits in the list/grid.
- **Action receipts**: click/fill/key actions now report popups, dialogs, downloads and console errors triggered by the action.
- **New upload / dialog / finish-space tools**: `browser_upload` picks local files, `browser_dialog` accepts/dismisses alert/confirm/prompt, and `browser_space_finish` closes this session's pages while keeping the ones handed back to the user.
- **Stable p1/p2 page labels with an 8-page budget**: `browser_list_tabs` shows the label, and the oldest page is recycled beyond 8 per session.
- **Browser operations from different sessions run in parallel**: operations within one space stay FIFO, while batches / multiple agents no longer queue behind each other.
- **Snapshot locators are uniqueness-checked**: repeated role+name nodes no longer advertise `loc=`, avoiding wrong recovery later.

### Fixed

- **Browser screenshots are now actually visible to vision models**: the screenshot is delivered as an image instead of truncated base64 text (fewer tokens, and readable).
- **Agents only operate their own browser tabs**: they no longer rewrite or close the tab you are using, and parallel agents no longer mix up each other's pages.
- **Browser calls can time out and be stopped**: navigation gives up after 45 s and other operations after 30 s with a readable hint, and the Stop button aborts an in-flight browser call.
- **Source editor supports Ctrl+V paste**: keyboard paste works again and matches the context menu (multiple cursors included).

### Improved

- **Page text is explicitly marked as untrusted data**: extracted content is wrapped in `untrusted_page_content` and the prompt tells the model to ignore instructions found on pages, reducing prompt-injection risk.
- Browser text extraction supports `offset` continuation, `browser_wait` is usable again, and the external MCP endpoint now rejects requests from non-local origins.

## 2026-10-20

### Added

- **The PDF context menu can rotate the whole document left or right**: view only — the file is untouched — with the same direction kept across page turns / scrolling and a one-click reset.
- **PDFs exported from Markdown now carry a table of contents**: the heading hierarchy is written as PDF bookmarks, so this app and other readers show a jumpable outline.
- **Page management can rotate the whole document**: the toolbar gains “All left” / “All right”, and the rotation is written into the PDF on save.

### Changed

- **The PDF context menu now uses submenus**: “Translation”, “Reading theme” and “Rotate view” live in second-level menus, with Manage pages pinned at the bottom.
- **The PDF reading theme, translation and page-management entries moved from the status bar into the context menu**: translation now offers page-by-page (overlay as you read) and full-document modes; full translation never overlays the pages, shows progress in the status bar, and its completion hint there saves the result as a Markdown file.
- **The view selector in the Knowledge Management toolbar moved to the far left**: it now has no border or background and matches the toolbar color, with the left-panel switch right after it.
- **The leftmost “view” tab in the Knowledge Management tab bar now shows only its icon**: the view name moved to the hover tooltip, leaving horizontal room for file tabs.

### Fixed

- **Rotating a PDF in single-window mode no longer shifts the whole UI up by a dozen pixels**: continuous-reading page jumps no longer use `scrollIntoView` (which scrolled ancestor containers such as the tab bar and toolbar), and stray ancestor scroll is reset after a rotation.
- **A PDF rotated to landscape was wider than the container even at 100%**: continuous reading now fits the page width in its current orientation, so rotation reflows to the container width and resets horizontal scroll.

## 2026-10-19

### Added

- **The plugin file capability now has one entry point (`ctx.fs`)**: identical on both halves, with target identity, versions and a literal "change just this one spot" edit, failures reported as stable error codes, and the writable scope still limited to the plugin folder plus paths the user granted.
- **Plugins can stream from a model directly**: output can be rendered as it arrives, or the model can be asked for JSON matching a given shape that the host parses and checks; failures and cancellation come back as stable error codes.
- **Delegated agents now have a handle layer**: a plugin can hold a handle to a running delegation, read its state and usage, run several delegations in parallel, and cancel or dispose repeatedly.
- **Plugins can generate images (permission `image`)**: a panel can do text-to-image or image-to-image with up to 3 reference images; failures come back as error codes instead of throwing, and the service URL and token stay user-configured.
- **Plugins can subscribe to observability events that belong to them**: calls to their own tools and output from delegations they started (including streaming deltas) are delivered to them, and other sessions and tools no longer leak in.
- **The delegated agent's working directory can be chosen**: the plugin permissions page gains a working-directory dropdown (default: knowledge-base root) whose options are only the writable folders the user granted; relative paths resolve against it and writes stay inside it.
- **New Settings → Tools → Fetch page**: `web_fetch`'s direct fetch / DeepSeek Fetch / virtual browser can each be toggled and dragged into a fallback order, with a URL box to test the chain.
- **TTS can use a Qwen3-TTS deployed on GPUStack over the LAN**: Qwen3-TTS gains a Deployment choice — enter the GPUStack URL and API key and pick the model, and playback / audio export go through its OpenAI-compatible endpoint instead of a local service.
- **Every associated file type now has its own icon**: PDF, Markdown, code, spreadsheets and the rest show distinct colours and labels in Explorer instead of the app icon; types already associated are switched over on startup, and the settings list shows each type's icon.

### Changed

- **The DeepSeek search source now uses the official Search API**: one request returns structured results (no model turn), billed per successful request, also available on mobile / web, with an option to include page content in the results.
- **The Knowledge Processing icon is now "layers"**: the old icon was Stack Overflow's brand logo and had nothing to do with the module.
- **Shortcut-related hints now point to Settings → Models → ASR**: they still said the removed Settings → Speech → ASR, so following them led nowhere.
- **Home chat-list order and sorting moved to a context menu**: right-click the list (blank area or a chat row) to switch between sequence and workspace grouping and to sort by last generated (default) or creation time; the toolbar toggle is gone, each row's timestamp follows the chosen basis, and a chat row's menu still ends with Delete Chat.

### Improved

- **The plugin development reference now matches the current plugin API**: the guide and the built-in MCP service cover files (`ctx.fs`), streaming and structured output, delegation handles, image generation and speech, add an "UI-half capabilities" topic with each capability's permission and its two failure shapes, and the self-check now verifies that every capability used is declared and that subscribed event types can actually fire (old spellings only get a migration hint).
- **BM25 keyword retrieval in the knowledge base now really works for Chinese**: tokenization handles mixed Chinese and English, and the BM25 switches and weights in retrieval settings are no longer ignored by the .kb archive.
- **Community-based retrieval strategies got their slice fallback and boost fixed**: community members map back to slices correctly, and strategies such as "dense + community" share the same base channels instead of scoring systematically weaker.

### Fixed

- **The model picker in Home no longer goes blank when an agent preset follows the default**: the source and model show the current global values, sending works, and a manual pick in the chat header stays with that chat.
- **Agent / swarm modes now pass attachment paths only**: dropped Word / Excel / Markdown files no longer put their full text into the prompt; the model reads them on demand with file tools.
- **The file-view child window now notices on-disk changes**: after an external edit, the status bar shows "File changed · Reload" and one click refreshes it instead of silently swapping the content.
- **Dropping Word / Excel / Markdown into Home no longer reports "Failed to read"**: files lost their disk path after the runtime upgrade, so the real path is now retrieved through preload; Excel files can also be picked from the attach button.
- **The speech shortcut was wrongly reported as an invalid key when only a file window was open**: with a file-association launch (no main window) the push-to-talk shortcut now registers and goes to the focused window.

## 2026-10-18

### Added

- **Auto-speak for assistant replies**: tick "Auto speak" under Settings → Models → TTS and each finished reply is read aloud (current chat only).
- **The app can start the Qwen3-TTS service itself**: set the install folder and click "Start service" to launch the local Python service (same as running the bat by hand), optionally on app start — no cmd window needed, and the folder is a setting rather than hard-coded.
- **Image generation (Qwen-Image-Edit-2511)**: Settings → Models → Image configures the service URL, model type (local Qwen / Banana2), size, steps, LoRA and token, and can generate right there with 0-3 reference images (no image = text-to-image, images = edit).
- **The app can start the image service too**: set the install folder and click "Start service" to launch Qwen-Image-Edit-2511 (including its bundled ComfyUI), optionally on app start; only processes it started are stopped on exit.

### Changed

- **Settings navigation**: the Models group now holds Sources / Embedding / TTS / ASR / Image / Credentials, and the former top-level "Speech" group is gone (TTS and ASR moved under Models).

### Fixed

- **Qwen3-TTS failed with `Unsupported languages: ['zh']`**: the language is now sent as one of the server's accepted names (Auto / Chinese / English…), and legacy `zh` values are mapped automatically.

### Improved

- **Qwen3-TTS integration rebuilt on the documented API**: voices are picked from a dropdown filled by `/update_voices`, with language, 0.6B–1.7B model, speed, chunk size and batch size, and the URL auto-detects 7862 (Gradio `/do_job`) versus 9880 (direct API).

## 2026-10-17

### Added

- **The tool registry can show enable state per scope**: a new scope dropdown hides the enable state by default (registry facts only) and can judge it by the global default, by a given agent preset, or by a live session's actual tool list; tools outside that scope are greyed as not enabled (desktop only).

## 2026-10-16

### Improved

- **An agent preset's source can now be set to "Follow default"**: the preset binds no source or model and uses whatever Settings → Model currently has, so switching sources or moving to another environment (new machine, new API key) no longer means editing every preset; built-in presets ship in that mode (and "Restore default" returns to it).
- **The home chat list sidebar is now a fixed 220px wide**: narrow windows no longer squeeze it to 150px — once the window gets too narrow the home page switches straight to phone mode (list and conversation each take the full screen).

### Fixed

- **Closing the window still warned that “KB evaluation” was running after a batch test finished**: an all-strategy test now unregisters its background task as soon as it ends (including manual stop or a failed preparation phase), so closing is no longer blocked and the tray stops listing a finished evaluation.

## 2026-10-15

### Added

- **Empty-navbar notice**: when every feature is off and no plugin panel is enabled, the main window shows a notice with “Restore default nav” and “Open settings” (the notice can be turned off under Settings → General → Basic).
- **Browser “Save Markdown to knowledge base”**: a new page action in the browser side panel turns the current article into Markdown inside the knowledge base (default `网页剪藏` subfolder, changeable to any subfolder or the root; the YAML header can be turned off).
- **New Firecrawl web search source**: works with no API key (add your own free key to use your own quota) and behaves like every other source — enable it, drag to reorder, test it alone, and let it take part in fallback / merge.
- **Voice input now types into any text field**: the shortcut writes into whatever field the caret is in — chat composer, search box, a settings field, the code editor (it works in the settings window and in the background too) — with one shared “Listening…” indicator at the bottom showing the target and the live text; hold to talk and release to finish (a short tap toggles continuous listening, Esc cancels), and when there is nothing to type into the result is copied to the clipboard. A small floating mic in the bottom-right corner starts the same thing on click (turn it off under Settings → Voice → ASR).

### Improved

- **The browser's new tab is now a full-page bookmark grid**: the in-page search box and the “Show all” collapse are gone — a new tab shows every bookmark at once (folders still open on click, overflow scrolls in place); search moved into the address bar, where URLs open directly, keywords use the selected engine, and the bar names the current engine.
- **Browser settings panel completed**: new-tab content (bookmark grid / blank page), address-bar search engine (with a custom URL template), bookmarks per row, the Markdown clip folder and YAML-header switch, plus a persisted “Allow AI to run JavaScript”; clearing the cache now asks for confirmation.
- **Settings merge: “General → Features” moved into “General → Basic”**: the module switches and the Knowledge Management view now live on the Basic page; the old entry point (`?nav=features`) and plugin cards targeting `features` still work.
- **“General → Data” no longer lists “Legacy todos & notes”**: that historical category is gone from the data inventory and from per-category export/import.
- **File associations completed for Linux / macOS**: on Linux the association actually works after a `.deb` install (the desktop entry declares the MIME types and mimeapps.list is written with the real desktop-entry name); the macOS build now appears in the “Open with” list without claiming the system default, and the settings page text was updated.
- **Each chat keeps its own composer content**: switching chats (and switching modules or restarting the app) no longer shares one input box — unfinished text stays in its own chat and comes back when you return to it.
- **New side panel on Home (Files / Terminal / Browser)**: the icon at the right end of the chat title bar opens it; the width is draggable and tabs can be added or closed, with the open state, width and tab set remembered **per chat**; the Files tab is the workspace tree (expand folders, click to open, insert a relative path into the input box) and the Terminal and Browser tabs land next.
- **The side panel’s Terminal tab works (a real terminal)**: it is a true PTY (interactive PowerShell / bash session) with colours, Ctrl+C, full-screen programs such as vim/top, and multiple terminal tabs; you type the commands and read the output yourself, so it is not limited by the Security Policy level and works at any of them.
- **The side panel’s Browser tab is embedded (browse in place)**: the page view is attached to the main window by the main process and laid out to the panel’s area, while the tab strip, address bar, bookmarks and settings rail are the browser module’s own UI; opening it folds in an already-open browser window, and tabs survive closing the panel. When a dialog or overlay opens in the main window the page view steps aside so nothing is covered.
- **Pick a workspace at the bottom-left of the input box (the agent works there)**: a new workspace button switches between existing workspaces or opens a new folder; the chosen workspace is the agent’s working directory and goes into its context (system prompt and tool path fence), and the side panel’s Files / Terminal tabs point at it too. The panel no longer seeds a Files tab by default — it opens empty and asks you to pick Terminal / Files / Browser.
- **The workspace is now per chat**: each chat can work in a different folder and switching chats no longer changes another chat’s directory; the picker offers “Follow global default”, and until you choose one the chat keeps using the global default workspace (which Knowledge Management still uses). The chat list gained an order switch: by sequence (draggable) or **grouped by workspace** with folder headers and counts.
- **The three top bars line up**: the sidebar toolbar (search / new chat), the chat header (title / model) and the side panel’s tab strip are now the same height, and the side-panel toggle now matches the sidebar `fa-bars` toggle exactly (icon only, no border or box), so switching between them no longer looks misaligned.
- **Startup console is quiet now**: no more cache-cleanup stack dumps, plugin / map / MCP / guest-policy chatter or Chromium GPU noise on launch (the key lines are English, since Chinese text came out garbled in the Windows console); set `AIKM_VERBOSE=1` to get the full log back. The main process also switched PDF parsing to pdfjs’s legacy build (the Node build, which no longer warns on import).

### Fixed

- **Top-bar icons covered the title once many plugin panels existed**: the nav-button row now scrolls horizontally (it no longer stretches the top bar) and the title is measured — it auto-hides when it no longer fits next to the buttons or the window controls, and comes back when the window grows or a plugin is disabled.
- **Main window stuck on Home when only one plugin panel is left**: with every feature off it now switches to that plugin panel; when the current panel is turned off or its plugin is uninstalled it only falls back to a panel that is still visible instead of a hidden Home (the Android back gesture likewise returns to the first visible panel).
- **Chat list crashed with “Cannot read properties of undefined (reading ‘updated’)”**: a comment node inside the drag-sort item slot made the sortable component throw in dev builds (it swallowed the first error and then died on that line); the slot now has exactly one root element per item, with a source-level self-test to keep it that way.
- **Holding the voice shortcut toggled recording over and over (the indicator strobed)**: on Windows a global shortcut keeps firing while the key is held down, so “pressed” looked like repeated clicks; the global shortcut is now unregistered while one of our windows has keyboard focus (the key simply reaches the window, which can tell press from release) and only registered again in the background, and repeat callbacks during a hold are merged into the same press.
- **Streaming voice kept typing “uh-huh” from background noise**: streaming segmentation now requires at least 200 ms of real speech in a segment (the same threshold the segmented engine already used), so breathing and key clicks are no longer turned into sentence after sentence, and the indicator stays on screen until the last result has been written.

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
- **Licence changed to noncommercial**: MIT → PolyForm Noncommercial 1.0.0 — any commercial use now requires a separate licence, while personal, study, research, education and public-interest use stays free (noncommercial redistribution allowed); README and installer metadata were updated.
- **Windows portable renamed**: the artifact is now `…_Portable.exe` instead of `…_Setup.exe`, so it is no longer confused with the installer (the installer keeps `_Setup`).

### Fixed

- **Agent Scaffold still showed Chinese in the English UI**: status bar (`共`/`出错`), round names and cross-round references (第1轮 → Round 1, normalized when old task files are opened, including references inside prompts), result-page and Excel column headers (`_行号` / `_轮次·` / `_来源`), the default result column name, log-page thread labels, graph tooltips and kind names, and instance tab names (Agent脚手架 1 → Agent Scaffold 1) now all follow the UI language.
- **Renamed export columns had no values on the result page or in Excel**: after renaming a custom column the header used the old name while the data used the new one (blank cells on the result page, shifted columns in the exported Excel); both now use the same column name.
- **Linux one-click packaging produced no artifacts**: fixed the failure of `scripts/build-linux-all.cmd`, which now produces all three packages — x64 (deb + AppImage) and arm64 (deb).

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


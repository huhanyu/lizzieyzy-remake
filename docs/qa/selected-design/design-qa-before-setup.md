# Selected workspace design QA

final result: passed

Scope: adaptation of user-selected first dark two-column mockup, with the user-requested Sabaki dot-and-line graph replacing the textual branch list. This is layout/interaction acceptance, not a new backend engine acceptance.

Source: /Users/ice/.codex/generated_images/01a0998e-c9c0-7bb2-a92a-8270ef60927a/exec-4ad25089-8e10-424c-8465-edecadf5b82f.png and user-supplied Sabaki screenshot.
Implementation: docs/qa/selected-design/desktop.png, 1440x1024 browser viewport. Source and saved implementation opened together for comparison. Board bounds measured 852x852; circles remain circular. Earlier captures taken immediately after viewport changes were stale and were replaced after layout settled.

Intentional differences: actual SGF players and 20-move sample, actual recorded engine frame values, single black-perspective chart with gaps left unfilled, existing theme assets and board overlay semantics. No invented player ranks, mock variations or fabricated historical curve. Graph is vertically scrollable, not a textual list. Existing menu groups and theme switching preserved. Current sample is a main line; true branches are driven by existing SGF tree DTOs.

Iteration findings and fixes:
- Candidate coordinates inherited dark text and chart inherited white canvas background. Fixed theme contrast and transparent chart canvas; recaptured.
- Nested graph scrollers clipped the current node. Graph now flexes inside panel, edit controls collapse independently.
- Toolbar compression hid filename/dirty state. Restored persistent filename and unsaved marker in status bar.
- Increased table/player typography at large desktop widths. Compact native sizes retained at small heights.

Verified: frontend TypeScript/Vite and Tauri debug app build passed. Browser node click 19 then ArrowUp selected 18; last-move navigation restores frame 20; ownership toggle and theme switch work; source/save actions remain reachable through existing menus/settings. Independent graph helper checks covered nested branch lane collisions, depth, orphan/cycle safety. Independent code review found no required callback loss. Native AX inspection showed new graph with 27 nodes and a genuine alternate branch after user edits. No new real-engine successful frame is claimed by this UI task.

Remaining polish: iconography and control density are not pixel-identical to generated artwork; generated text and fake chart were intentionally not copied. Theme selection remains beside display controls. This change does not add the mockup-only hand-number/try-play toggles. Existing editing tools remain available in the collapsed panel/settings.

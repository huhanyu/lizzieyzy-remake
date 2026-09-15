# One-click setup design QA — 2026-09-15

final result: passed

Scope: user-selected design 1 implemented as a modal in the existing desktop workspace. Existing workspace QA retained in docs/qa/selected-design/design-qa-before-setup.md.

Source visual truth: /Users/ice/.codex/generated_images/01a0998e-c9c0-7bb2-a92a-8270ef60927a/exec-545185e3-d966-42c5-8c20-549a4a37f103.png
Implementation: docs/qa/evidence/one-click-setup/overview-browser.jpg
Native final state: docs/qa/evidence/one-click-setup/native-final.jpg

## Comparison evidence

Source and browser implementation were opened together in the same comparison input. Both full-view images are 1487 × 1058 pixels; browser CSS viewport was 1487 × 1058. No resampling was applied. The source is a full-page concept; implementation is a dismissible modal preserving the board underneath. Browser state includes an explicit preview notice and unavailable native actions; native state shows genuine installed models and detected hardware. Native screenshot is tool-scaled 1080 × 768; it is functional/visual corroboration, not a pixel-exact density comparison. Full-view text and cards were readable; separate focused crops were not required.

## Findings and iteration history

- P2, first implementation: optional HumanSL row clipped at the reference viewport. Increased dialog maximum height from 960 to 1010 pixels and retained an independently scrolling body/fixed footer. Post-fix overview-browser.jpg shows both optional rows and persistent footer.
- P2, native model label: managed files displayed generic model.bin.gz. Resolve installed resource display name by path; native-final.jpg shows 均衡分析.
- Responsive checks: at 1280 × 840 and 640 × 800 CSS viewports, DOM measurements found no horizontal dialog overflow and footer remained reachable. Supporting tool captures overview-1280.jpg and overview-640.jpg have provider-scaled dimensions, and are not claimed as 1:1 viewport screenshots. Temporary viewport overrides were reset.
- No remaining actionable P0/P1/P2 finding in this scope.

## Required fidelity surfaces

- Typography: native system Chinese sans-serif, 30-pixel maximum main heading, clear card/subheading hierarchy, readable muted secondary text. Intentionally smaller than the generated full-page concept to fit the existing modal and actual text.
- Spacing/layout: sidebar, three-card row, current engine/model pair, optional modules and speed card, fixed action footer follow design 1. Compact viewports stack cards and scroll content.
- Colors/tokens: charcoal surfaces, muted gray-blue copy, teal selection and primary action; restrained borders replace the concept's stronger gradients.
- Images: reused existing photorealistic black/white stone PNG assets; standard Phosphor icons. No invented logo or generated engine screenshot. Deep plan uses the same two-stone asset treatment for consistency.
- Copy: real download sizes, actual install state and device detection. HumanSL explicitly installs resources only. Browser cannot download/benchmark and says so. No mock speed or fabricated hardware result.

## Interactions and accessibility

Browser: open modal, choose each plan, toggle optional models, navigate model list/download empty state/speed page, verify native actions disabled in browser. Native dialog focus handling and Escape/close respect in-flight work. Focus-visible outline and semantic pressed/switch states implemented. Browser console inspection returned no errors.

Native: stop active analysis, download balanced plus quick, verify and load models, save configurations, run real benchmark and apply 8-thread recommendation, relaunch updated QA build, reuse installed balanced model and save through atomic comparison. Full backend evidence is in ONE_CLICK_SETUP_20260915.md.

Remaining P3: spacing/icon silhouettes are an adaptation, not a pixel-identical recreation of generated art. Screen-reader behavior beyond native AX and keyboard focus checks was not exhaustively tested.

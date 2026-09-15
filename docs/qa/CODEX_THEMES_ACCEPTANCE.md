# Three board themes acceptance — 2026-09-14

Implemented board/stone skins: BadukTV, Photorealistic, Subdued, plus classic fallback. Picker is at board top right. Selected theme persists through a separate localStorage key. Normal stones, ghost stones and numbered PV stones use the same theme assets; candidate and ownership layers remain available. Assets are bundled offline; licenses, upstream CSS and pinned hashes are in apps/desktop/public/themes.

Verification:
- TypeScript and Vite production build passed.
- Tauri debug macOS app bundle build passed.
- Browser UI: switched each of the three themes and visually inspected actual textures and stone alignment. Subdued selected value survives reload; numbered PV overlay visible with new stones.
- Narrow browser layout: removed second-row picker positioning that covered upper board coordinates.
- Independent subagent review: all 17 asset checksums matched sources.json; async image race guard, cache, independent persistence, default cursor and preview rendering reviewed. Save-failure message and unused BadukTV backdrop findings fixed.

Boundary: current native app has an unsaved 21-move Untitled SGF. It was intentionally left open; the new bundle is built but this theme version has not been visually accepted in a freshly launched native window. Browser is recorded-engine preview, not proof of a new real-engine run. No backend code changed for this feature.

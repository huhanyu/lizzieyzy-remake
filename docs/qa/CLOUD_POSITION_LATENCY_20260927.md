# Cloud position switching — 2026-09-27

Observed in source: every switch sent boardsize/rules/komi, clear/setup, the entire move history, then analyze. Socket worker sent at most 16 commands before a blocking read (100 ms IO tick).

Changed: acknowledged cloud positions can use stop + undo/play suffix + analyze. Rules, komi, setup, handicap changes, unacknowledged boards, forced side-to-play history, and large backwards jumps rebuild. Local and SSH replay remain unchanged. Generation guard skips obsolete queued targets; response ID boundaries remain enforced. Socket drain bound is 512 commands, IO tick 20 ms.

Validation: 36 live review tests passed (one explicitly ignored environment test); 12 cloud socket tests passed. Two delta command tests passed. Explicit real KataGo delta/full showboard comparison passed for advance, rewind, and branch changes. No authenticated cloud before/after latency measurement was performed. Native application rebuilt; release assets not updated.

# Task 1a — command registry and parser

Implemented in `packages/client-core/src/commands/registry.ts`, with public exports in `packages/client-core/src/index.ts`.

## Public API

- `CommandDefinition`, `CommandOption`, `CommandContext`, `CommandInvocation`, and `CommandResult` provide the typed command contract.
- `COMMANDS` contains 63 canonical command definitions, including queue, role, announcement, poll, and reminder subcommands. IDs use space-separated paths.
- `commandById`, `searchCommands`, `parseCommand`, and `validateCommandArgs` are pure helpers. Search ranks exact, prefix, then substring/description matches and returns at most 25 results.
- Parsing supports positional and free-text tail arguments, quoted values, `name:value`, duplicate/unexpected argument detection, required-argument feedback, incomplete groups, unknown commands, and the `//` literal escape. Entity values stay opaque strings for the UI resolver to replace with selected stable IDs.

## Verification

- `npm test -- --run src/commands/registry.test.ts` — passed, 8 tests.
- `npm run typecheck --workspace @dilla/client-core` — blocked by existing/concurrent failures in `src/bot/protocol.ts` and `src/core-wasm-conformance.ts`. No diagnostic points to the registry, its tests, or the export block.
- `git diff --check` — passed.

The targeted tests cover catalog uniqueness and representative complete catalog paths, every argument kind family, opaque entity IDs, required/optional and range/choice validation, quoted Unicode, free-text tails and URLs, parent groups versus queue leaf behavior, literal/code text, malformed quotes, duplicates, extras, and search ranking/capping.

## Concerns

- Poll answer parsing and reminder timezone/DST interpretation remain higher-level UI/handler responsibilities; this registry validates only the supplied strings and basic duration/number/choice forms.
- Human entity-name ambiguity is intentionally not handled here; the composer must resolve and submit stable IDs.

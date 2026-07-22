# LBAS Target and Equipment Multiplier Design

## Purpose

The optimizer must rank event equipment bonuses without hiding unverified rules
inside search order. Multiplier data can lag new events, so every automatic rule
must be inspectable and replaceable by a scenario-local custom rule.

## Scenario Model

`combatContext` is shared by the simulator, optimizer, worker, and CLI:

```json
{
  "targetTags": ["event-2026-e3", "boss"],
  "multiplierRules": [
    {
      "id": "e3-land-attacker-a",
      "label": "E-3 land attacker group A",
      "enabled": true,
      "targetTags": ["event-2026-e3"],
      "equipmentMasterIds": [301, 372],
      "equipmentTypes": [],
      "group": "event-2026-e3-group-a",
      "multiplier": 1.18,
      "source": "custom",
      "overridden": true
    }
  ]
}
```

Tags are normalized trimmed strings. ID/type lists are unique positive integers.
Multipliers must be finite and greater than zero. Invalid rules make CLI
validation and optimization return an input error instead of silently changing
damage.

## Matching and Stacking

A rule matches one plane when it is enabled, every rule target tag exists in the
scenario target tags, and either its master-ID list or equipment-type list
contains the plane. Empty equipment selectors are invalid.

Matching rules are grouped by `group`. Rules in the same group represent
alternatives and only the largest multiplier applies. Independent groups stack
multiplicatively. The result is applied after the existing LBAS soft cap and
equipment-type post-cap modifier. A plane with no matching rule has multiplier
`1`.

This deterministic rule is deliberately explicit. It supports common event
bonus tables without embedding event-specific constants in the engine, and it
keeps exact-search ordering, pruning bounds, simulation, and final ranking on the
same objective.

## Sources and Overrides

The engine does not claim official multiplier data where the game API provides
none. A future catalog adapter may populate rules from Poi master data first and
community fixtures second. Imported rules retain `source` metadata. Editing any
field turns the rule into `source: "custom"` and `overridden: true`; refreshes may
update only untouched automatic rules.

For the first release, UI and CLI support complete custom rules. This is the
required stale-data fallback and is also the correctness baseline for future
catalog imports.

## Interaction

The enemy panel gets a collapsed "Equipment damage multipliers" editor. It
contains a comma-separated target-tag input and compact rule rows for label,
master IDs, equipment types, target tags, stacking group, multiplier, enabled,
and delete. Add creates an enabled custom `1.0` rule that the user can edit.

The editor is available in static and detailed modes. Result damage remains the
same field already used for ranking; the UI shows the effective multiplier next
to each equipped plane when it differs from `1`.

## Exact Search

All damage helpers accept `combatContext`. Group damage features, candidate
summaries, branch bounds, fixed-sample simulation, and final scores use the same
per-plane effective multiplier. Bounds may ignore inventory conflicts but must
never use a smaller multiplier than a reachable completion.

Because multiplier matching depends only on immutable plane attributes and the
scenario context, applying the exact helper everywhere preserves the existing
proof argument.

## Verification

- Same-group matches take the maximum and independent groups multiply.
- Target tags and equipment selectors must both match.
- Invalid custom rules are rejected.
- Static and detailed production results match exhaustive oracles with bonuses.
- A bonus can change the proved optimal loadout.
- Scenario normalization, worker transport, CLI JSON, and UI edits preserve the
  same `combatContext`.
- Existing no-bonus fixtures remain byte-for-byte score compatible.

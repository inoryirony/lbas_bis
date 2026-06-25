# lbas_bis

Poi plugin MVP for KanColle LBAS air power and loadout optimization.

## MVP scope

- Manual inputs only: target radius, enemy air power, base count, and target air states.
- Uses current owned equipment from Poi state.
- Optimizes 4-slot LBAS loadouts without reusing the same equipment instance.
- Calculates sortie air power, fighter proficiency bonus, improvement bonus, land recon coefficient, range extension, and air state thresholds.
- Shows top loadout plans with air power, air state, radius, attack score, and used equipment.

## Not in this MVP

- No templates or map presets.
- No blue bonus rules.
- No day/night battle optimizer.
- No enemy slot attrition simulation between LBAS waves. If wave-by-wave enemy air differs, enter it manually in a later version.

## Development

```bash
npm install
npm test
npm run typecheck
```

The plugin entry is `index.js`, exported as a Poi `reactClass` with `windowMode`.

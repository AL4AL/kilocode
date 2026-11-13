# Kilo Code Surge (Kilo+)

**Kilo Code Surge** is an [AL4AL](https://github.com/AL4AL) distribution of [Kilo Code](https://github.com/Kilo-Org/kilocode): one engine, extra integrations and fixes on our cadence, while we track upstream.

| Name | Meaning |
|---|---|
| **Kilo Code Surge** | Full product name in docs and the VS Code marketplace title when you publish a Surge build |
| **Kilo+** | Short label in CLI version strings and casual references |
| **Kilo Code** | The upstream project; Surge does not replace it |

## Lineage

- Upstream: [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)
- This fork: [AL4AL/kilocode](https://github.com/AL4AL/kilocode)
- OpenCode lineage (Kilo CLI) is unchanged; see the root README FAQ.

Surge-specific code lives under `packages/opencode/src/kilocode/` and in marked `kilocode_change` hunks in shared files.

## Install

Build from this repository (see [CONTRIBUTING.md](./CONTRIBUTING.md)) or install a Surge VSIX. Official Marketplace packages from Kilo-Org are **upstream Kilo Code** (`kilocode.kilo-code`), not Surge.

| Surge VS Code extension id | Publisher | Package name |
|---|---|---|
| `al4al.kilo-code-surge` | `al4al` | `kilo-code-surge` |

You can install Surge alongside upstream Kilo Code; settings, commands, and storage are namespaced separately (`kilo-code-surge.*`).

## Contributing

- **Surge-only features:** open PRs on AL4AL/kilocode.
- **Changes that belong in core Kilo:** contribute to Kilo-Org/kilocode; we merge upstream regularly.

## Trademark and attribution

Kilo and Kilo Code are used here to identify the upstream project. Surge is not affiliated with Kilo-Org. Keep upstream copyright and MIT license notices intact.

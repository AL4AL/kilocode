// kilocode_change - new file
/** Branding for the AL4AL distribution (Kilo Code Surge / Kilo+). */
export const Surge = {
  display: "Kilo Code Surge",
  short: "Kilo+",
  edition: "Surge",
  maintainer: "AL4AL",
  upstream: "https://github.com/Kilo-Org/kilocode",
  repo: "https://github.com/AL4AL/kilocode",
  tagline: "Built on Kilo Code",
  vscodeExtensionId: "al4al.kilo-code-surge",
} as const

export function surgeVersion(base: string) {
  return `${base}+surge (${Surge.short} · ${Surge.maintainer})`
}

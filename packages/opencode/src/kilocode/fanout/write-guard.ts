import { guard } from "./scope"

/** Block fan-out child writes outside owned paths before file tools run. */
export async function assertFanoutWrite(sessionID: string | undefined, filepath: string) {
  await guard(sessionID, filepath)
}
import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createNativeStore } from "../../src/services/native-runtime/store"

const dirs: string[] = []

async function root() {
  const path = await mkdtemp(join(tmpdir(), "kilo-native-runtime-"))
  dirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("native runtime store", () => {
  it("starts fresh and persists isolated directory scopes", async () => {
    const path = await root()
    const store = createNativeStore(path)
    const first = resolve(path, "workspace-a")
    const second = resolve(path, "workspace-b")

    expect((await store.load(first)).data).toEqual({})
    await store.update(first, (data) => ({ ...data, title: "first" }))
    await store.update(second, (data) => ({ ...data, title: "second" }))

    expect((await store.load(first)).data).toEqual({ title: "first" })
    expect((await store.load(second)).data).toEqual({ title: "second" })
  })

  it("isolates named documents within a directory scope", async () => {
    const path = await root()
    const store = createNativeStore(path)
    const dir = resolve(path, "workspace")
    await store.update(dir, (data) => ({ ...data, title: "session" }), "session-a")
    await store.update(dir, (data) => ({ ...data, title: "session" }), "session-b")

    expect((await store.load(dir, "session-a")).data).toEqual({ title: "session" })
    expect((await store.load(dir, "session-b")).revision).toBe(1)
    expect((await store.load(dir, "session-c")).revision).toBe(0)
  })

  it("serializes writes from separate extension-host store instances", async () => {
    const path = await root()
    const first = createNativeStore(path)
    const second = createNativeStore(path)
    const dir = resolve(path, "workspace")

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? first : second).update(dir, (data) => ({ ...data, count: Number(data.count ?? 0) + 1 })),
      ),
    )

    const doc = await first.load(dir)
    expect(doc.revision).toBe(24)
    expect(doc.data.count).toBe(24)
  })

  it("serializes concurrent recovery of a dead extension-host lock", async () => {
    const path = await root()
    const stores = [createNativeStore(path), createNativeStore(path)]
    const dir = resolve(path, "workspace")
    const scope = process.platform === "win32" ? dir.toLowerCase() : dir
    const hash = createHash("sha256").update(scope).digest("hex")
    const file = join(path, "native-runtime", "v1", `${hash}.json`)
    await mkdir(join(path, "native-runtime", "v1"), { recursive: true })
    await mkdir(`${file}.lock`)
    await writeFile(join(`${file}.lock`, "owner"), JSON.stringify({ pid: 2_147_483_647, at: 0, token: "dead" }))

    await Promise.all(
      stores.map((store) => store.update(dir, (data) => ({ ...data, count: Number(data.count ?? 0) + 1 }))),
    )

    const doc = await stores[0].load(dir)
    expect(doc.revision).toBe(2)
    expect(doc.data.count).toBe(2)
  })

  it("recovers the previous complete revision after a damaged write", async () => {
    const path = await root()
    const store = createNativeStore(path)
    const dir = resolve(path, "workspace")
    const scope = process.platform === "win32" ? dir.toLowerCase() : dir
    const hash = createHash("sha256").update(scope).digest("hex")
    const file = join(path, "native-runtime", "v1", `${hash}.json`)

    await store.update(dir, (data) => ({ ...data, value: "old" }))
    await store.update(dir, (data) => ({ ...data, value: "new" }))
    await writeFile(file, "{damaged")

    expect(await store.load(dir)).toMatchObject({ revision: 1, data: { value: "old" } })
    expect(await readFile(`${file}.bak`, "utf8")).toContain('"value":"old"')
  })

  it("does not commit a failed state transformation", async () => {
    const path = await root()
    const store = createNativeStore(path)
    const dir = resolve(path, "workspace")
    await store.update(dir, (data) => ({ ...data, value: 1 }))

    await expect(store.update(dir, () => Promise.reject(new Error("failed")))).rejects.toThrow("failed")

    expect(await store.load(dir)).toMatchObject({ revision: 1, data: { value: 1 } })
  })
})

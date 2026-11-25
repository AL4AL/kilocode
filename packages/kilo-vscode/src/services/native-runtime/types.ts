export type NativeJson = string | number | boolean | null | NativeJson[] | { [key: string]: NativeJson }

export type NativeJsonObject = { [key: string]: NativeJson }

export type NativeDocument = {
  version: 1
  scope: string
  revision: number
  updatedAt: number
  data: NativeJsonObject
}

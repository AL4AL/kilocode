export const EXTENSION_PUBLISHER = "al4al"
export const EXTENSION_NAME = "kilo-code-surge"
export const EXTENSION_ID = `${EXTENSION_PUBLISHER}.${EXTENSION_NAME}` as const
export const EXTENSION_DISPLAY_NAME = "Kilo+ Surge"

/** Must match `contributes.viewsContainers.activitybar[].id` in package.json. */
export const ACTIVITY_BAR_CONTAINER_ID = "kilo-code-surge-ActivityBar"

/** Must match `contributes.views` webview id and `registerWebviewViewProvider` viewType. */
export const SIDEBAR_VIEW_ID = "kilo-code-surge.SidebarProvider"

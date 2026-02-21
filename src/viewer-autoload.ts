const WARM_ACTIONS = ['86_Talking', '88_Thinking'] as const

export async function resolveAutoLoadModelURL(): Promise<string> {
  let configModelUrl = ''
  try {
    const resp = await fetch('./clawatar.config.json')
    if (resp.ok) {
      const config = await resp.json()
      configModelUrl = config.model?.url || ''
    }
  } catch {}

  const savedUrl = localStorage.getItem('vrm-model-url') || ''
  return configModelUrl || savedUrl
}

export function persistModelURL(modelUrl: string): void {
  if (!modelUrl) return
  localStorage.setItem('vrm-model-url', modelUrl)
}

export function warmConversationActions(
  preloadAction: (actionId: string) => Promise<unknown>
): void {
  window.setTimeout(() => {
    void Promise.allSettled(WARM_ACTIONS.map((actionId) => preloadAction(actionId)))
  }, 250)
}

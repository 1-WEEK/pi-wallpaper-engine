import { createAuthClient } from "better-auth/client"
import { passkeyClient } from "@better-auth/passkey/client"

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
})

export type Session = Awaited<ReturnType<typeof authClient.getSession>>["data"]

export const fetchSession = async (): Promise<Session | null> => {
  const result = await authClient.getSession()
  return result.data ?? null
}

export interface SetupState {
  enabled: boolean
  setup_complete: boolean
  max_passkeys?: number
}

export interface PasskeyRecord {
  id: string
  name?: string | null
  createdAt: string
  deviceType?: string | null
  backedUp?: boolean
}

export const listPasskeys = async (): Promise<PasskeyRecord[]> => {
  const res = await fetch("/api/auth/passkey/list-user-passkeys")
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as PasskeyRecord[]
}

export const deletePasskey = async (id: string): Promise<void> => {
  const res = await fetch("/api/auth/passkey/delete-passkey", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
  }
}

export const fetchSetupState = async (): Promise<SetupState> => {
  const res = await fetch("/api/auth/setup-state")
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as SetupState
}

export const setupAdmin = async (params: {
  token: string
  email: string
  name: string
}): Promise<void> => {
  const randomPassword = crypto.randomUUID() + crypto.randomUUID()
  const res = await fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pwe-setup-token": params.token,
    },
    body: JSON.stringify({
      email: params.email,
      name: params.name,
      password: randomPassword,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
  }
}

export const registerPasskey = async (name?: string) => {
  const result = await authClient.passkey.addPasskey({ name })
  if (result?.error) throw new Error(result.error.message ?? "Passkey registration failed")
}

export const signInPasskey = async () => {
  const result = await authClient.signIn.passkey()
  if (result?.error) throw new Error(result.error.message ?? "Passkey sign-in failed")
}

export const signOut = async () => {
  await authClient.signOut()
}

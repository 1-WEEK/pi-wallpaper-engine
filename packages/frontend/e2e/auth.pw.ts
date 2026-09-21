// Ticket 14 — Login/Setup light treatment (spec §9): typographic skeleton
// pages on the --pt-* token layer (dual theme), glass only for the passkey
// focused overlay, passkey flow behavior unchanged.
import { expect, test } from "playwright/test"
import type { Page, Route } from "playwright"

const mockSetupState = (page: Page, state: Record<string, unknown>) =>
  page.route("**/api/auth/setup-state", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    })
  )

const mockNoSession = (page: Page) =>
  page.route("**/api/auth/get-session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "null" })
  )

/** Stall an endpoint until the returned release function is called, so the
 *  passkey ceremony stays pending and the focused overlay can be asserted. */
const stallRoute = async (page: Page, path: string, body: unknown, status = 200) => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**${path}`, (r: Route) => {
    void gate.then(() =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
    )
  })
  return () => release?.()
}

const shellBg = (page: Page) =>
  page.locator(".auth-shell").evaluate((el) => getComputedStyle(el).backgroundColor)

test.describe("Login (ticket 14)", () => {
  test("renders the typographic skeleton in both themes", async ({ page }) => {
    await mockSetupState(page, { enabled: true, setup_complete: true })
    await mockNoSession(page)

    await page.emulateMedia({ colorScheme: "dark" })
    await page.goto("/")
    await expect(page.locator(".auth-brand")).toHaveText("PI WALLPAPER ENGINE")
    await expect(page.locator(".auth-title")).toHaveText("Sign in")
    await expect(page.locator(".auth-row-val")).toHaveText("PASSKEY")
    const cmd = page.getByRole("button", { name: "SIGN IN WITH PASSKEY →" })
    await expect(cmd).toBeVisible()
    // THEME[B] pure black — the token layer, not the legacy ink.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    expect(await shellBg(page)).toBe("rgb(0, 0, 0)")
    // The command is a ≥44px touch target.
    expect((await cmd.boundingBox())!.height).toBeGreaterThanOrEqual(44)

    // THEME[A] cream via AUTO following the OS.
    await page.emulateMedia({ colorScheme: "light" })
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await expect(page.locator(".auth-title")).toHaveText("Sign in")
    expect(await shellBg(page)).toBe("rgb(251, 250, 244)")
  })

  test("passkey ceremony shows the glass focused overlay; cancel abandons the wait", async ({
    page,
  }) => {
    await mockSetupState(page, { enabled: true, setup_complete: true })
    await mockNoSession(page)
    // The WebAuthn options request stays pending until released.
    const release = await stallRoute(page, "/api/auth/passkey/generate-authenticate-options**", {
      error: "mocked",
    })

    await page.goto("/")
    await page.getByRole("button", { name: "SIGN IN WITH PASSKEY →" }).click()

    const focus = page.locator(".auth-focus")
    await expect(focus).toBeVisible()
    await expect(focus.locator(".auth-focus-reading")).toHaveText(/WAITING FOR PASSKEY/)
    // The overlay is the page's only glass: §2.4 heavy blur recipe.
    const backdrop = await focus
      .locator(".auth-focus-panel")
      .evaluate((el) => getComputedStyle(el).backdropFilter)
    expect(backdrop).toContain("blur(28px)")

    // Cancel abandons the wait — a late failure must not surface an error.
    await focus.getByRole("button", { name: "CANCEL" }).click()
    await expect(focus).toHaveCount(0)
    release()
    await expect(page.locator(".auth-error")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "SIGN IN WITH PASSKEY →" })).toBeEnabled()
  })

  test("a failed ceremony surfaces the error inline, next to the command", async ({ page }) => {
    await mockSetupState(page, { enabled: true, setup_complete: true })
    await mockNoSession(page)
    await page.route("**/api/auth/passkey/generate-authenticate-options", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "ceremony unavailable" }),
      })
    )

    await page.goto("/")
    await page.getByRole("button", { name: "SIGN IN WITH PASSKEY →" }).click()

    await expect(page.locator(".auth-error")).toContainText("ERR —")
    // The overlay left with the ceremony.
    await expect(page.locator(".auth-focus")).toHaveCount(0)
  })
})

test.describe("Setup (ticket 14)", () => {
  test("token form → passkey step with the glass focused overlay", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockSetupState(page, { enabled: true, setup_complete: false })
    // A signed-in session (post sign-up) so addPasskey proceeds to the
    // register-options call instead of failing with Unauthorized.
    await page.route("**/api/auth/get-session", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "admin@pi.local", name: "Admin" },
          session: { id: "s1", token: "t", userId: "u1" },
        }),
      })
    )

    let setupPosted: { email: string } | null = null
    await page.route("**/api/auth/sign-up/email", (r) => {
      setupPosted = r.request().postDataJSON() as { email: string }
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    const release = await stallRoute(page, "/api/auth/passkey/generate-register-options**", {
      error: "mocked",
    })

    await page.goto("/")
    await expect(page.locator(".auth-title")).toHaveText("Setup")
    await expect(page.locator(".auth-row-val")).toHaveText("STEP 1/2 — CREATE ADMIN")
    expect(await shellBg(page)).toBe("rgb(0, 0, 0)")

    await page.locator('input[type="password"]').fill("setup-token-123")
    await page.locator('input[type="email"]').fill("admin@pi.local")
    await page.getByRole("button", { name: "CREATE ADMIN →" }).click()

    await expect.poll(() => setupPosted?.email).toBe("admin@pi.local")
    await expect(page.locator(".auth-row-val")).toHaveText("STEP 2/2 — REGISTER PASSKEY")

    await page.getByRole("button", { name: "REGISTER PASSKEY →" }).click()
    const focus = page.locator(".auth-focus")
    await expect(focus).toBeVisible()
    await focus.getByRole("button", { name: "CANCEL" }).click()
    await expect(focus).toHaveCount(0)
    release()
  })
})

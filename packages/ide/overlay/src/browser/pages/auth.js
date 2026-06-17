;(() => {
  // Staged single-input flow: every auth page is a list of [data-stage]
  // sections showing one input at a time. The crumb row labels the input and
  // navigates back; the status beside it carries live guidance. On the password
  // step the breach check runs on the confirming click - a hit turns the button
  // red and using it anyway takes a second, informed click. The cloud error
  // page has no stages and no form logic.
  const form = document.querySelector(".auth-form")
  const stages = form ? Array.from(form.querySelectorAll("[data-stage]")) : []
  const status = form ? form.querySelector("[data-status]") : null
  const submit = form ? form.querySelector('.submit-button[type="submit"]') : null
  const submitText = submit ? submit.querySelector("span") : null
  if (!form || !stages.length || !status || !submit || !submitText) return

  const crumbs = Array.from(form.querySelectorAll("[data-crumb]"))
  const inputs = stages.map((stage) => stage.querySelector("input"))
  const passwordIndex = inputs.findIndex((input) => input?.hasAttribute("data-password-input"))
  const confirmIndex = inputs.findIndex((input) => input?.hasAttribute("data-password-confirm"))
  const passwordInput = passwordIndex >= 0 ? inputs[passwordIndex] : null
  const passwordCheck = passwordIndex >= 0 ? window.composeryPasswordCheck : undefined

  const compactNumber = new Intl.NumberFormat("en", { notation: "compact" })
  let current = 0
  // The server-rendered error (wrong password, rate limit) owns the status
  // line until the user interacts; then the stage messaging takes over.
  let serverError = !!status.textContent.trim()
  // Breach result for the password just checked: status is one of
  // "idle" | "checking" | "found" | "clear" | "unavailable". Bound to the exact
  // value so editing the field invalidates it.
  let breach = { password: "", status: "idle" }
  let breachController
  // A step whose value only the server can judge (the current password) is being
  // checked server-side right now.
  let verifying = false

  // The check that just ran, or a fresh idle result once the value has changed.
  function currentBreach() {
    return passwordInput && breach.password === passwordInput.value
      ? breach
      : { password: passwordInput?.value ?? "", status: "idle" }
  }

  function setStatus(message, tone) {
    const changed = status.textContent !== message
    status.textContent = message
    status.classList.remove("success", "destructive")
    if (tone) status.classList.add(tone)
    // Re-trigger the fade only when the visible message actually changes to
    // something, so a message that holds across keystrokes never flickers.
    if (changed && message) {
      status.classList.remove("auth-fade")
      void status.offsetWidth
      status.classList.add("auth-fade")
    }
  }

  function renderStatus() {
    if (serverError) return
    if (verifying) {
      setStatus("Checking…")
      return
    }
    if (current === passwordIndex && passwordCheck) {
      const value = passwordInput.value
      const check = currentBreach()
      if (check.status === "checking") {
        setStatus("Checking breaches…")
      } else if (check.status === "found") {
        setStatus(`Seen ${compactNumber.format(check.count)} times`, "destructive")
      } else if (value) {
        setStatus(passwordCheck.checkStrength(value).message)
      } else {
        setStatus("")
      }
      passwordInput.setAttribute("aria-invalid", check.status === "found" ? "true" : "false")
    } else if (current === confirmIndex) {
      const input = inputs[confirmIndex]
      if (!input.value) {
        input.removeAttribute("aria-invalid")
        setStatus("")
        return
      }
      const matches = input.value === passwordInput?.value
      input.setAttribute("aria-invalid", matches ? "false" : "true")
      setStatus(matches ? "Matches" : "Doesn't match", matches ? "success" : "destructive")
    } else {
      setStatus("")
    }
  }

  function renderSubmit() {
    const check = currentBreach()
    let label = stages[current].dataset.button
    let variant
    if (current === passwordIndex && passwordCheck) {
      const value = passwordInput.value
      if (check.status === "found") {
        label = "Use it anyway"
        variant = "destructive"
      } else if (value && !passwordCheck.checkStrength(value).ok) {
        label = "Use anyway?"
        variant = "warning"
      }
    } else if (current === confirmIndex) {
      // Once the two entries agree, the finishing step goes green so it reads
      // as the deliberate last action rather than the form starting over.
      const value = inputs[confirmIndex].value
      if (value && value === passwordInput?.value) variant = "success"
    }
    submitText.textContent = label
    submit.classList.remove("warning", "destructive", "success")
    if (variant) submit.classList.add(variant)
    const busy = verifying || (current === passwordIndex && check.status === "checking")
    submit.disabled = busy
    submit.setAttribute("aria-busy", busy ? "true" : "false")
  }

  function render() {
    stages.forEach((stage, index) => {
      stage.toggleAttribute("hidden", index !== current)
      // A required input inside a display:none stage is not focusable, so
      // the browser silently refuses to submit the whole form - the submit
      // event never fires and advance() never runs (the button looks dead).
      // Only the visible stage carries the constraint; hidden stages keep
      // their value for the final POST, they just stop blocking submission.
      inputs[index]?.toggleAttribute("required", index === current)
    })
    for (const crumb of crumbs) {
      const index = Number(crumb.dataset.crumb)
      crumb.toggleAttribute("hidden", index > current)
      if (crumb.matches("button")) {
        if (index === current) crumb.setAttribute("aria-current", "step")
        else crumb.removeAttribute("aria-current")
      }
    }
    renderStatus()
    renderSubmit()
  }

  function setStage(index) {
    current = index
    render()
    // Opacity-only entrance for the newly revealed input, retriggered by
    // re-adding the class after a reflow.
    const stage = stages[index]
    stage.classList.remove("auth-stage-enter")
    void stage.offsetWidth
    stage.classList.add("auth-stage-enter")
    inputs[index]?.focus()
  }

  // Breach check for the current password value. checkPwned now talks only to
  // this origin (password-check.js relays the range request server-side), so
  // this is a same-origin call the server already bounds - the abort is just a
  // last-resort ceiling. A server that cannot reach the range API answers quickly
  // and the check resolves to "unavailable", which proceeds unchecked; only a
  // real hit blocks with the two-click reveal.
  async function checkBreach(password) {
    const existing = currentBreach()
    if (existing.status !== "idle") return existing.status
    breachController?.abort()
    const controller = new AbortController()
    breachController = controller
    const timeout = setTimeout(() => controller.abort(), 8000)
    breach = { password, status: "checking" }
    render()
    try {
      const count = await passwordCheck.checkPwned(password, controller.signal)
      if (passwordInput.value !== password) return "unavailable"
      breach = { count, password, status: count > 0 ? "found" : "clear" }
    } catch {
      if (passwordInput.value !== password) return "unavailable"
      breach = { password, status: "unavailable" }
    } finally {
      clearTimeout(timeout)
    }
    render()
    return breach.status
  }

  // Server check for a step only the server can judge (the current password), so it
  // is answered where the user is standing instead of after three more stages.
  // A transport failure is not a rejection: the submit still validates, so the
  // flow proceeds rather than blocking on a hiccup.
  async function verifyValue(url, field, value) {
    verifying = true
    render()
    try {
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ [field]: value }),
      })
      if (!response.ok) return { ok: true }
      const body = await response.json().catch(() => null)
      // Only an explicit { valid: false } from the verify endpoint is a
      // rejection. A missing route, an unrelated 401, or a 5xx all mean
      // "cannot verify" - never "wrong" - and the submit has the final say.
      if (!body || typeof body.valid !== "boolean" || body.valid) {
        return { ok: true }
      }
      return {
        ok: false,
        message: body.reason === "rate-limit" ? "Too many attempts" : "Incorrect password",
      }
    } catch {
      return { ok: true }
    } finally {
      verifying = false
    }
  }

  async function advance() {
    const input = inputs[current]
    if (input && !input.reportValidity()) return
    const verifyUrl = stages[current].dataset.verify
    if (verifyUrl && input) {
      const outcome = await verifyValue(verifyUrl, stages[current].dataset.verifyField, input.value)
      if (!outcome.ok) {
        serverError = false
        renderSubmit()
        setStatus(outcome.message, "destructive")
        input.setAttribute("aria-invalid", "true")
        input.focus()
        return
      }
      input.setAttribute("aria-invalid", "false")
    }
    if (current === passwordIndex && passwordCheck) {
      const password = input.value
      // A breach found by this click only reveals its red state; using the
      // password anyway takes a second, informed click. An unavailable check
      // never blocks - it proceeds unchecked.
      const alreadyBreached = currentBreach().status === "found"
      const result = await checkBreach(password)
      if (passwordInput.value !== password) return
      if (result === "checking") return
      if (result === "found" && !alreadyBreached) return
    }
    if (current === confirmIndex && input.value !== passwordInput?.value) {
      serverError = false
      renderStatus()
      input.focus()
      return
    }
    if (current < stages.length - 1) {
      serverError = false
      setStage(current + 1)
      return
    }
    // Everything is validated; submit directly on a fresh task. form.submit()
    // bypasses the submit event (so this handler cannot re-enter and stall)
    // and the deferral leaves the current dispatch, where a form whose submit
    // is already firing refuses to submit again.
    setTimeout(() => form.submit(), 0)
  }

  inputs.forEach((input, index) => {
    input?.addEventListener("input", () => {
      serverError = false
      // Clear a server rejection (wrong current password) as soon as the
      // value changes; renderStatus re-derives it for the staged fields.
      input.removeAttribute("aria-invalid")
      if (index === passwordIndex) {
        breachController?.abort()
        breach = { password: "", status: "idle" }
      }
      renderStatus()
      renderSubmit()
    })
  })

  for (const crumb of crumbs) {
    if (!crumb.matches("button")) continue
    crumb.addEventListener("click", () => {
      const index = Number(crumb.dataset.crumb)
      if (index >= current) return
      serverError = false
      setStage(index)
    })
  }

  // Play the button glyph once per hover/focus and let it finish even when the
  // pointer leaves mid-way; a CSS :hover animation snaps the icon back the
  // instant the cursor leaves.
  const playGlyph = () => {
    if (submit.disabled) return
    submit.classList.remove("glyph-play")
    void submit.offsetWidth
    submit.classList.add("glyph-play")
  }
  submit.addEventListener("pointerenter", playGlyph)
  submit.addEventListener("focus", playGlyph)

  form.addEventListener("submit", (event) => {
    // The staged flow drives submission itself (advance -> form.submit());
    // a raw submit (Enter key, autofill) must run through it first.
    event.preventDefault()
    void advance()
  })

  render()
})()

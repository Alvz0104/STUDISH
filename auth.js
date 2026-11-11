"use strict";
  function getAuthAccounts() {
    const stored = localStorage.getItem(ACCOUNTS_KEY);
    if (!stored) return [];
    const accounts = JSON.parse(stored);
    if (!Array.isArray(accounts)) throw new Error("Saved account data is invalid. Clear this browser's STUDISH account data and try again.");
    return accounts;
  }
  // Derive a salted password hash with the browser's Web Crypto API.
  async function hashPassword(password, saltHex) {
    if (!window.crypto?.subtle || !window.crypto.getRandomValues) {
      throw new Error("Secure password hashing is unavailable. Open STUDISH through localhost (for example, XAMPP) and try again.");
    }
    const salt = saltHex
      ? Uint8Array.from(saltHex.match(/.{2}/g) || [], byte => parseInt(byte, 16))
      : window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await window.crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS },
      key,
      256
    );
    const hash = [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const saltValue = [...salt].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { hash, salt: saltValue };
  }
  // Show sign-in feedback with matching accessible status styling.
  function setAuthMessage(message, isError = true) {
    const element = $("#authMessage");
    element.textContent = message;
    element.classList.toggle("is-error", isError);
    element.classList.toggle("is-success", Boolean(message) && !isError);
  }
  // Switch between sign-in and registration fields and instructions.
  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === "register";
    $("#authHeading").textContent = registering ? "Create your account" : "Welcome back";
    $(".auth-intro").textContent = registering
      ? "Create a local profile to keep your study space organized."
      : "Sign in to pick up where you left off.";
    $("#authNameField").classList.toggle("hidden", !registering);
    $("#authConfirmField").classList.toggle("hidden", !registering);
    $("#authName").required = registering;
    $("#authConfirmPassword").required = registering;
    $("#authPassword").autocomplete = registering ? "new-password" : "current-password";
    $("#authSubmit").textContent = registering ? "Create account" : "Sign in";
    $("#authSwitchText").textContent = registering ? "Already have an account?" : "New to STUDISH?";
    $("#authModeToggle").textContent = registering ? "Sign in" : "Create an account";
    setAuthMessage("");
  }
  // Establish the account session, load its data, and show the dashboard.
  function enterApp(account, initialState = null) {
    const user = { id: account.id, email: account.email, name: account.name || "" };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    currentUser = user;
    state = initialState || loadData();
    selectedReviewerId = null;
    timerMode = state.settings.timerMode;
    pomodoroPhase = state.settings.pomodoroPhase;
    pomodoroCount = state.settings.pomodoroCount;
    if (initialState && saveData()) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.warn("Could not remove legacy STUDISH data after migration:", error);
      }
    }
    $("#accountGreeting").textContent = `Hi, ${user.name || user.email.split("@")[0]}`;
    $("#authScreen").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    $("#sessionLength").value = state.settings.sessionLength;
    $("#sessionSeconds").value = state.settings.sessionSeconds;
    $("#pomodoroShortBreak").value = state.settings.pomodoroShortBreak;
    $("#pomodoroLongBreak").value = state.settings.pomodoroLongBreak;
    loadScheduleControls();
    remainingSeconds = getTimerDurationSeconds();
    $("#startTimer").disabled = false;
    $("#pauseTimer").disabled = true;
    updateTimerDisplay();
    updateTimerPresets();
    updatePomodoroControls();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "Break ready" : "Ready", onBreak ? "on-break" : "");
    $("#timerSubtext").textContent = timerMode === "pomodoro" && pomodoroPhase !== "focus"
      ? "Start your break when you are ready."
      : "Ready when you are";
    applyTheme(state.settings.theme || "light");
    renderAll();
    switchView("dashboard");
  }
  // Validate credentials or create an account before opening the app.
  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthMessage("");
    const email = $("#authEmail").value.trim().toLowerCase();
    const password = $("#authPassword").value;
    if (!$("#authForm").reportValidity()) return;

    authBusy = true;
    $("#authSubmit").disabled = true;
    try {
      const accounts = getAuthAccounts();
      if (authMode === "register") {
        const name = $("#authName").value.trim();
        const confirmPassword = $("#authConfirmPassword").value;
        if (password.length < 8) {
          setAuthMessage("Use a password with at least 8 characters.");
          return;
        }
        if (password !== confirmPassword) {
          setAuthMessage("Those passwords do not match.");
          return;
        }
        if (accounts.some(account => account.email === email)) {
          setAuthMessage("An account with that email already exists. Please sign in.");
          return;
        }
        const firstAccount = accounts.length === 0;
        const previousData = firstAccount ? state : null;
        const credentials = await hashPassword(password);
        const account = {
          id: window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${credentials.salt}`,
          name,
          email,
          passwordHash: credentials.hash,
          passwordSalt: credentials.salt
        };
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...accounts, account]));
        enterApp(account, previousData);
        return;
      }

      const account = accounts.find(item => item.email === email);
      if (!account) {
        setAuthMessage("Email or password is incorrect.");
        return;
      }
      const credentials = await hashPassword(password, account.passwordSalt);
      if (credentials.hash !== account.passwordHash) {
        setAuthMessage("Email or password is incorrect.");
        return;
      }
      enterApp(account);
    } catch (error) {
      console.warn("Could not complete STUDISH authentication:", error);
      setAuthMessage(error.message || "Unable to complete sign-in. Please try again.");
    } finally {
      authBusy = false;
      $("#authSubmit").disabled = false;
    }
  }
  // Stop account-specific activity and return to the sign-in screen.
  function signOut() {
    if (timerRunning) pauseTimer();
    sessionStorage.removeItem(SESSION_KEY);
    currentUser = null;
    state = structuredClone(DEFAULT_STATE);
    selectedReviewerId = null;
    $("#appShell").classList.add("hidden");
    $("#authScreen").classList.remove("hidden");
    $("#authForm").reset();
    setAuthMode("login");
    $("#authEmail").focus();
  }
  // Show a short-lived status message and replace any message already visible.
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    // Hide the toast automatically after its display interval.
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 2400);
  }
  // Display the requested page and refresh its view-specific content.

// Keep app state and helper functions private to this page.
(() => {
  "use strict";

  const STORAGE_KEY = "studish_data_v1";
  const ACCOUNTS_KEY = "studish_accounts_v1";
  const SESSION_KEY = "studish_session_v1";
  const PASSWORD_ITERATIONS = 210000;
  const DEFAULT_SCHEDULE_SETTINGS = { dailyMinutes: 120, studyDays: [1, 2, 3, 4, 5], startTime: "18:00", breakMinutes: 5, horizonDays: 14 };
  const DEFAULT_STATE = {
    tasks: [],
    records: [],
    reviewers: [],
    schedule: null,
    settings: {
      sessionLength: 25,
      sessionSeconds: 0,
      theme: "light",
      schedule: DEFAULT_SCHEDULE_SETTINGS,
      timerMode: "single",
      pomodoroShortBreak: 5,
      pomodoroLongBreak: 15,
      pomodoroCount: 0,
      pomodoroPhase: "focus"
    }
  };
  // Restore the signed-in profile from this browser session.
  function readCurrentUser() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      return saved && typeof saved.id === "string" && typeof saved.email === "string"
        ? { id: saved.id, email: saved.email, name: String(saved.name || "") }
        : null;
    } catch (error) {
      console.warn("Could not restore the STUDISH session:", error);
      return null;
    }
  }
  let currentUser = readCurrentUser();
  let state = loadData();
  let authMode = "login";
  let authBusy = false;
  let timerMode = state.settings.timerMode === "pomodoro" ? "pomodoro" : "single";
  let pomodoroPhase = ["focus", "shortBreak", "longBreak"].includes(state.settings.pomodoroPhase)
    ? state.settings.pomodoroPhase
    : "focus";
  let pomodoroCount = Number.isInteger(state.settings.pomodoroCount)
    ? Math.min(4, Math.max(0, state.settings.pomodoroCount))
    : 0;
  let timerInterval = null;
  let remainingSeconds = timerMode === "pomodoro" && pomodoroPhase !== "focus"
    ? Number(state.settings[pomodoroPhase === "shortBreak" ? "pomodoroShortBreak" : "pomodoroLongBreak"]) * 60
    : state.settings.sessionLength * 60 + state.settings.sessionSeconds;
  let timerRunning = false;
  let selectedReviewerId = null;
  let toastTimeout = null;
  let completionAudioContext = null;
  let completionAudioUnavailable = false;

  // Find the first DOM element matching a CSS selector.
  const $ = (selector) => document.querySelector(selector);
  // Return all matching DOM elements as a regular array.
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  // Format the current local date as YYYY-MM-DD for date comparisons.
  const todayISO = () => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };
  // Convert a YYYY-MM-DD date into a readable label.
  const formatDate = (iso) => {
    if (!iso) return "No deadline";
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  // Build and validate a task's local deadline date and time.
  const getDeadlineDate = (task) => {
    if (!task.deadline || !/^\d{4}-\d{2}-\d{2}$/.test(task.deadline)) return null;
    const time = task.deadlineTime || "23:59:59";
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) return null;
    const [year, month, day] = task.deadline.split("-").map(Number);
    const [hour, minute, second = 0] = time.split(":").map(Number);
    const deadline = new Date(year, month - 1, day, hour, minute, second);
    if (deadline.getFullYear() !== year || deadline.getMonth() !== month - 1 || deadline.getDate() !== day ||
      deadline.getHours() !== hour || deadline.getMinutes() !== minute || deadline.getSeconds() !== second) return null;
    return deadline;
  };
  // Check whether a pending task's deadline has already passed.
  const isOverdue = (task) => {
    const deadline = getDeadlineDate(task);
    return !task.completed && deadline !== null && deadline.getTime() < Date.now();
  };
  // Escape user-provided text before placing it in generated HTML.
  const escapeHTML = (value) => String(value ?? "").replace(
    /[&<>"']/g,
    // Replace each HTML-sensitive character with its safe entity.
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
  // Convert a date to a local YYYY-MM-DD value without a timezone shift.
  const formatISODate = (date) => {
    const normalized = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return normalized.toISOString().slice(0, 10);
  };
  // Keep each account's saved study data separate in local storage.
  function getUserStorageKey() {
    return currentUser ? `${STORAGE_KEY}_${currentUser.id}` : STORAGE_KEY;
  }
  // Apply the selected color theme and remember it with the profile.
  function applyTheme(themeName = "light") {
    const theme = themeName === "dark" ? "dark" : "light";
    document.body.dataset.theme = theme;
    const toggle = document.getElementById("themeToggle");
    if (toggle) toggle.textContent = theme === "dark" ? "Light mode" : "Dark mode";
    state.settings.theme = theme;
    saveData();
  }
  // Count consecutive calendar days that include a completed focus session.
  function calculateStudyStreak() {
    const studyDays = new Set(state.records
      .filter(record => record.date)
      .map(record => record.date)
      .filter(Boolean));
    let streak = 0;
    const cursor = new Date();
    while (studyDays.has(formatISODate(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  // Load saved tasks, study records, and settings, filling in missing defaults.
  function loadData() {
    try {
      const saved = JSON.parse(localStorage.getItem(getUserStorageKey()));
      if (saved && Array.isArray(saved.tasks) && Array.isArray(saved.records)) {
        return {
          ...DEFAULT_STATE,
          ...saved,
          reviewers: Array.isArray(saved.reviewers) ? saved.reviewers : [],
          schedule: saved.schedule && Array.isArray(saved.schedule.sessions) ? saved.schedule : null,
          settings: {
            ...DEFAULT_STATE.settings,
            ...(saved.settings || {}),
            timerMode: saved.settings?.timerMode === "pomodoro" ? "pomodoro" : "single",
            pomodoroShortBreak: Math.min(30, Math.max(1, Number(saved.settings?.pomodoroShortBreak) || 5)),
            pomodoroLongBreak: Math.min(60, Math.max(1, Number(saved.settings?.pomodoroLongBreak) || 15)),
            pomodoroCount: Math.min(4, Math.max(0, Math.floor(Number(saved.settings?.pomodoroCount) || 0))),
            pomodoroPhase: ["focus", "shortBreak", "longBreak"].includes(saved.settings?.pomodoroPhase)
              ? saved.settings.pomodoroPhase
              : "focus",
            schedule: {
              ...DEFAULT_SCHEDULE_SETTINGS,
              ...((saved.settings && saved.settings.schedule) || {}),
              studyDays: Array.isArray(saved.settings?.schedule?.studyDays)
                ? saved.settings.schedule.studyDays
                : [...DEFAULT_SCHEDULE_SETTINGS.studyDays]
            }
          }
        };
      }
    } catch (error) { console.warn("Could not load STUDISH data:", error); }
    return structuredClone(DEFAULT_STATE);
  }
  // Persist the current application state and report storage errors to the user.
  function saveData() {
    if (!currentUser) return false;
    try {
      localStorage.setItem(getUserStorageKey(), JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn("Could not save STUDISH data:", error);
      showToast("Unable to save data. Check this browser's storage settings.");
      return false;
    }
  }
  // Read account records and reject malformed stored data explicitly.
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
  function switchView(viewName) {
    // Keep the displayed page and navigation highlight in sync.
    $$(".view").forEach(view => view.classList.toggle("active", view.id === `${viewName}View`));
    // Keep the navigation highlight in sync with the displayed page.
    $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === viewName));
    if (viewName === "tasks") renderTasks();
    if (viewName === "focus") renderRecords();
    if (viewName === "schedule") renderSchedule();
    if (viewName === "reviewers") {
      renderReviewerLibrary();
      renderReviewer();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // Update dashboard counts and the overall completion progress bar.
  function renderStats() {
    const total = state.tasks.length;
    const completed = state.tasks.filter(task => task.completed).length;
    const pending = total - completed;
    const overdue = state.tasks.filter(isOverdue).length;
    const percentage = total ? Math.round(completed / total * 100) : 0;
    const todaySeconds = state.records
      .filter(record => record.date === todayISO())
      .reduce((sum, record) => sum + (Number(record.durationSeconds) || Number(record.minutes || 0) * 60), 0);
    const nextTask = [...state.tasks.filter(task => !task.completed)]
      .sort((a, b) => (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity))[0];
    const streak = calculateStudyStreak();

    $("#totalStat").textContent = total;
    $("#completedStat").textContent = completed;
    $("#pendingStat").textContent = pending;
    $("#overdueStat").textContent = overdue;
    $("#completionText").textContent = `${percentage}%`;
    $("#completionBar").style.width = `${percentage}%`;
    $("#todayFocus").textContent = formatStudyTime(todaySeconds);
    $("#nextTaskLabel").textContent = nextTask ? nextTask.title.slice(0, 18) + (nextTask.title.length > 18 ? "…" : "") : "Ready";
    $("#nextTaskMeta").textContent = nextTask ? (nextTask.subject || "General study") : "No task scheduled";
    $("#streakStat").textContent = `${streak} day${streak === 1 ? "" : "s"}`;

    const todayPlan = [...state.tasks]
      .filter(task => !task.completed)
      .sort((a, b) => (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity))
      .slice(0, 3);
    const list = $("#todayPlanList");
    list.innerHTML = todayPlan.length
      ? todayPlan.map(task => {
          const deadline = getDeadlineDate(task);
          const dueLabel = deadline ? `${formatDate(task.deadline)} · ${deadline.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "No deadline";
          return `<div class="plan-item"><span class="plan-dot"></span><div><strong>${escapeHTML(task.title)}</strong><small>${escapeHTML(task.subject)}</small></div><span class="plan-date">${escapeHTML(dueLabel)}</span></div>`;
        }).join("")
      : '<div class="empty-plan">No pending tasks. You are all caught up.</div>';
  }
  // Return the status text and style associated with a task deadline.
  function getDeadlineStatus(task, deadline) {
    if (task.completed) return { label: "Completed", className: "deadline-completed" };
    const remaining = deadline.getTime() - Date.now();
    if (remaining <= 0) return { label: "Overdue", className: "deadline-overdue" };
    const days = Math.floor(remaining / 86400000);
    const hours = Math.floor(remaining % 86400000 / 3600000);
    const minutes = Math.floor(remaining % 3600000 / 60000);
    const isToday = deadline.toDateString() === new Date().toDateString();
    if (isToday) return { label: `${hours}h ${minutes}m left`, className: "deadline-today" };
    if (days < 1) return { label: `${hours}h ${minutes}m left`, className: "deadline-urgent" };
    if (days < 7) return { label: `${days}d ${hours}h left`, className: "deadline-soon" };
    return { label: `${days}d left`, className: "deadline-normal" };
  }
  // Create the HTML for one task row, optionally using the compact dashboard layout.
  function taskMarkup(task, compact = false) {
    const deadline = getDeadlineDate(task);
    const overdue = isOverdue(task);
    const status = deadline ? getDeadlineStatus(task, deadline) : { label: "No deadline", className: "deadline-normal" };
    const dateLabel = deadline
      ? `${formatDate(task.deadline)} · ${deadline.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
      : "No deadline";
    const completedAt = Number(task.completedAt);
    const completionDate = task.completed && Number.isFinite(completedAt) && completedAt > 0
      ? new Date(completedAt)
      : null;
    const completionLabel = completionDate && !Number.isNaN(completionDate.getTime())
      ? `Finished ${completionDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${completionDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
      : "";
    const notePreview = task.notes ? `<div class="task-note-preview">${escapeHTML(task.notes)}</div>` : "";
    return `<article class="task-row ${task.completed ? "is-complete" : ""} ${overdue ? "is-overdue" : ""}" data-task-id="${escapeHTML(task.id)}">
      <input class="task-check" type="checkbox" aria-label="Mark ${escapeHTML(task.title)} complete" data-action="toggle" ${task.completed ? "checked" : ""}>
      <div class="task-main">
        <p class="task-title">${escapeHTML(task.title)}</p>
        <div class="task-meta"><span>${escapeHTML(task.subject)}</span><span class="separator">|</span><time class="${overdue ? "overdue-text" : ""}" ${deadline ? `datetime="${deadline.toISOString()}"` : ""}>${dateLabel}</time><span class="deadline-badge ${status.className}">${status.label}</span>${completionLabel ? `<time class="task-completed-at" datetime="${completionDate.toISOString()}">${completionLabel}</time>` : ""}</div>
        ${notePreview}
      </div>
      <div class="task-side"><span class="priority-pill ${task.priority.toLowerCase()}">${escapeHTML(task.priority)}</span>${compact ? "" : `<div class="task-actions"><button type="button" data-action="edit">Edit</button><button type="button" data-action="delete">Delete</button></div>`}</div>
    </article>`;
  }
  // Show the four nearest pending tasks in the dashboard.
  function renderUpcoming() {
    // Exclude finished tasks from the dashboard's upcoming list.
    const upcoming = state.tasks.filter(task => !task.completed)
      // Compare deadlines, placing tasks without valid deadlines last.
      .sort((a, b) => (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity))
      .slice(0, 4);
    // Render each selected task using the compact row layout.
    $("#upcomingList").innerHTML = upcoming.map(task => taskMarkup(task, true)).join("");
    $("#emptyUpcoming").classList.toggle("hidden", upcoming.length > 0);
  }
  // Populate the subject selector while retaining its current choice when possible.
  function populateSubjectFilter() {
    const select = $("#subjectFilter");
    const selected = select.value;
    // Read each task's subject before discarding empty values and removing duplicates.
    const subjects = [...new Set(state.tasks.map(task => task.subject)
      // Ignore empty subject values before building the unique list.
      .filter(Boolean))]
      // Sort subject names alphabetically for easier selection.
      .sort((a, b) => a.localeCompare(b));
    // Create one safe option for each available subject.
    select.innerHTML = '<option value="">All subjects</option>' + subjects.map(subject => `<option value="${escapeHTML(subject)}">${escapeHTML(subject)}</option>`).join("");
    select.value = subjects.includes(selected) ? selected : "";
  }
  // Filter, sort, and display tasks using the current search and filter controls.
  function renderTasks() {
    populateSubjectFilter();
    const search = $("#searchInput").value.trim().toLowerCase();
    const subject = $("#subjectFilter").value;
    const priority = $("#priorityFilter").value;
    const status = $("#statusFilter").value;
    const sortValue = $("#sortOrder").value || "deadline";
    const priorityScore = { Low: 1, Medium: 2, High: 3 };
    // Keep only tasks matching all active filters.
    const filtered = state.tasks.filter(task => {
      // Test each task against the title, subject, priority, and status controls.
      const matchesSearch = task.title.toLowerCase().includes(search);
      const matchesSubject = !subject || task.subject === subject;
      const matchesPriority = !priority || task.priority === priority;
      const matchesStatus = !status || (status === "completed" ? task.completed : status === "overdue" ? isOverdue(task) : !task.completed && !isOverdue(task));
      return matchesSearch && matchesSubject && matchesPriority && matchesStatus;
    });

    const sorted = filtered.sort((a, b) => {
      if (sortValue === "priority") {
        return (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0) || Number(a.completed) - Number(b.completed);
      }
      if (sortValue === "subject") {
        return a.subject.localeCompare(b.subject) || Number(a.completed) - Number(b.completed) || (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity);
      }
      if (sortValue === "created") {
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      }
      return Number(a.completed) - Number(b.completed) ||
        (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity);
    });
    // Render each matching task as a full task row.
    $("#taskList").innerHTML = sorted.map(task => taskMarkup(task)).join("");
    $("#taskCountLabel").textContent = `${sorted.length} ${sorted.length === 1 ? "task" : "tasks"}`;
    $("#emptyTasks").classList.toggle("hidden", sorted.length > 0);
  }
  // Calculate study-record totals and render the most recent sessions.
  function renderRecords() {
    const today = todayISO();
    // Include only records whose saved date matches the user's local date.
    const todayRecords = state.records.filter(record => record.date === today);
    // Support both records with exact seconds and older records saved in minutes.
    const getRecordSeconds = record => Number.isFinite(Number(record.durationSeconds))
      ? Math.max(0, Number(record.durationSeconds))
      : Math.max(0, Number(record.minutes) || 0) * 60;
    // Sum today's valid session durations.
    const todaySeconds = todayRecords.reduce((sum, record) => sum + getRecordSeconds(record), 0);
    // Sum every saved session duration for the all-time total.
    const totalSeconds = state.records.reduce((sum, record) => sum + getRecordSeconds(record), 0);
    $("#todayMinutes").textContent = formatStudyTime(todaySeconds);
    $("#allMinutes").textContent = formatStudyTime(totalSeconds);
    $("#recordTotal").textContent = `${state.records.length} ${state.records.length === 1 ? "session" : "sessions"}`;
    // Sort a copy so displaying records does not reorder the stored array.
    const recent = [...state.records].sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0));
    // Render each record with a completion date, time, and readable duration.
    $("#recordsList").innerHTML = recent.map(record => {
      const completedAt = Number(record.completedAt);
      const completedDate = Number.isFinite(completedAt) && completedAt > 0 ? new Date(completedAt) : null;
      const dateLabel = completedDate
        ? completedDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
        : formatDate(record.date);
      const timeLabel = completedDate
        ? completedDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
        : "Time unavailable";
      const durationSeconds = getRecordSeconds(record);
      return `<article class="record-item">
        <span class="record-icon" aria-hidden="true">✓</span>
        <div class="record-details"><strong>Focus session</strong><span>${dateLabel} · ${timeLabel}</span></div>
        <span class="record-duration">${formatRecordDuration(durationSeconds)}</span>
      </article>`;
    }).join("");
    $("#emptyRecords").classList.toggle("hidden", recent.length > 0);
  }
  // Format a study-time total using the largest useful units.
  function formatStudyTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;
    if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes) return seconds ? `${minutes}m ${seconds}s` : `${minutes} min`;
    return `${seconds} sec`;
  }
  // Format a session duration for the compact record-list display.
  function formatRecordDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (!minutes) return `${seconds}<small>s</small>`;
    if (!seconds) return `${minutes}<small>min</small>`;
    return `${minutes}<small>m</small> ${seconds}<small>s</small>`;
  }
  // Read the selected focus duration from the minute and second inputs.
  function getConfiguredDurationSeconds() {
    return Number($("#sessionLength").value) * 60 + Number($("#sessionSeconds").value);
  }
  // Restore saved availability settings into the schedule form.
  function loadScheduleControls() {
    const settings = { ...DEFAULT_SCHEDULE_SETTINGS, ...(state.settings.schedule || {}) };
    $("#scheduleDailyMinutes").value = settings.dailyMinutes;
    $("#scheduleStartTime").value = settings.startTime;
    $("#scheduleBreakMinutes").value = settings.breakMinutes;
    $("#scheduleHorizon").value = String(settings.horizonDays);
    $$('input[name="studyDay"]').forEach(input => {
      input.checked = settings.studyDays.map(Number).includes(Number(input.value));
    });
  }
  // Fingerprint pending tasks so the UI can detect an outdated plan.
  function getScheduleTaskSignature(tasks = state.tasks.filter(task => !task.completed)) {
    return JSON.stringify(tasks.map(task => ({
      id: task.id,
      title: task.title,
      subject: task.subject,
      deadline: task.deadline,
      deadlineTime: task.deadlineTime,
      priority: task.priority,
      estimatedMinutes: Number(task.estimatedMinutes) || 60
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
  }
  // Format a 24-hour schedule time using the user's locale.
  function scheduleTimeLabel(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  // Display generated sessions and flag plans made stale by task edits.
  function renderSchedule() {
    const schedule = state.schedule;
    const hasSchedule = Boolean(schedule);
    const sessions = hasSchedule ? schedule.sessions : [];
    const unplanned = hasSchedule ? (schedule.unplanned || []) : [];
    const stale = hasSchedule && schedule.taskSignature !== getScheduleTaskSignature();

    $("#scheduleEmpty").classList.toggle("hidden", sessions.length > 0);
    $("#scheduleEmpty").querySelector("strong").textContent = !hasSchedule
      ? "No schedule yet"
      : unplanned.length && !sessions.length ? "No sessions fit in this plan" : "Nothing to plan yet";
    $("#scheduleEmpty").querySelector("p").textContent = !hasSchedule
      ? "Add tasks with deadlines, set your availability, and generate a plan."
      : unplanned.length && !sessions.length
        ? "Try adding study days or increasing your available time, then generate a new plan."
        : "All your tasks are complete. Add a task whenever you have more to study.";
    $("#scheduleStats").classList.toggle("hidden", !hasSchedule);
    $("#scheduleGeneratedAt").classList.toggle("hidden", !hasSchedule);
    $("#scheduleUnplanned").classList.toggle("hidden", !unplanned.length);
    $("#scheduleNotice").classList.toggle("hidden", !stale);
    if (stale) {
      $("#scheduleNotice").textContent = "Your task list has changed since this plan was generated. Generate a new schedule to bring it up to date.";
    }
    if (!hasSchedule) {
      $("#scheduleSummary").textContent = "Generate a schedule to see your upcoming study sessions.";
      $("#scheduleGeneratedAt").textContent = "";
      $("#scheduleSessionCount").textContent = "0";
      $("#scheduleStudyTime").textContent = "0 min";
      $("#scheduleUnplannedCount").textContent = "0";
      $("#scheduleDayList").innerHTML = "";
      $("#scheduleUnplannedList").innerHTML = "";
      return;
    }

    const studyDays = new Set(sessions.map(session => session.date)).size;
    const totalMinutes = sessions.reduce((total, session) => total + session.minutes, 0);
    $("#scheduleSummary").textContent = sessions.length
      ? `${sessions.length} focused ${sessions.length === 1 ? "session" : "sessions"} across ${studyDays} ${studyDays === 1 ? "study day" : "study days"} in the next ${schedule.settings.horizonDays} days.`
      : unplanned.length ? "No sessions could be scheduled with the selected availability." : "All your tasks are complete. Nothing needs scheduling.";
    $("#scheduleGeneratedAt").textContent = `Generated ${new Date(schedule.generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    $("#scheduleSessionCount").textContent = sessions.length;
    $("#scheduleStudyTime").textContent = `${totalMinutes} min`;
    $("#scheduleUnplannedCount").textContent = unplanned.length;

    const groupedSessions = new Map();
    sessions.forEach(session => {
      if (!groupedSessions.has(session.date)) groupedSessions.set(session.date, []);
      groupedSessions.get(session.date).push(session);
    });
    $("#scheduleDayList").innerHTML = [...groupedSessions.entries()].map(([date, daySessions]) => {
      const dayTotal = daySessions.reduce((total, session) => total + session.minutes, 0);
      const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric"
      });
      return `<section class="schedule-day">
        <div class="schedule-day-heading"><h3>${escapeHTML(dayLabel)}</h3><span>${dayTotal} min</span></div>
        <div class="schedule-session-list">${daySessions.map(session => {
          const endMinutes = Number(session.startTime.slice(0, 2)) * 60 + Number(session.startTime.slice(3)) + session.minutes;
          const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
          return `<article class="schedule-session">
            <span class="schedule-session-time">${escapeHTML(scheduleTimeLabel(session.startTime))}<small>${escapeHTML(scheduleTimeLabel(endTime))}</small></span>
            <div class="schedule-session-details">
              <strong>${escapeHTML(session.title)}</strong>
              <span>${escapeHTML(session.subject)} · ${session.minutes} min · ${escapeHTML(session.priority)} priority</span>
            </div>
            <button class="button button-outline schedule-start-button" type="button" data-schedule-start="${session.minutes}" data-task-id="${escapeHTML(session.taskId)}">Start</button>
          </article>`;
        }).join("")}</div>
      </section>`;
    }).join("");
    $("#scheduleUnplannedList").innerHTML = unplanned.map(item => `<article class="schedule-unplanned-item">
      <div><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.subject)} · ${item.remainingMinutes} min remaining</span></div>
      <p>${escapeHTML(item.reason)}</p>
    </article>`).join("");
  }
  // Turn note sentences into key points and simple recall questions.
  function createReviewerContent(source) {
    const sentences = source
      .split(/(?<=[.!?])\s+|\n+/)
      .map(sentence => sentence.trim().replace(/\s+/g, " "))
      .filter(sentence => sentence.length >= 20);
    const uniqueSentences = [...new Set(sentences)].slice(0, 10);
    if (!uniqueSentences.length) return null;

    const stopWords = new Set([
      "about", "after", "again", "being", "between", "could", "every", "first",
      "from", "have", "other", "their", "there", "these", "those", "which",
      "while", "where", "would", "should", "because", "through", "during"
    ]);
    const questions = uniqueSentences.slice(0, 5).map(sentence => {
      const keywords = sentence.match(/\b[A-Za-z][A-Za-z-]{4,}\b/g) || [];
      const answer = keywords.find(word => !stopWords.has(word.toLowerCase())) || keywords[0];
      if (!answer) return { prompt: `Explain this idea in your own words: ${sentence}`, answer: sentence };
      const escapedAnswer = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        prompt: `Fill in the missing key term: ${sentence.replace(new RegExp(`\\b${escapedAnswer}\\b`, "i"), "_____")}`,
        answer
      };
    });
    return {
      keyPoints: uniqueSentences.slice(0, 8),
      questions
    };
  }
  // List saved reviewers newest-first and mark the selected one.
  function renderReviewerLibrary() {
    const reviewers = state.reviewers || [];
    $("#reviewerCount").textContent = `${reviewers.length} ${reviewers.length === 1 ? "reviewer" : "reviewers"}`;
    $("#emptyReviewers").classList.toggle("hidden", reviewers.length > 0);
    $("#reviewerLibraryList").innerHTML = [...reviewers]
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .map(reviewer => `<article class="reviewer-library-item${reviewer.id === selectedReviewerId ? " selected" : ""}" data-reviewer-id="${escapeHTML(reviewer.id)}">
        <button class="reviewer-open-button" type="button" data-reviewer-action="open">
          <strong>${escapeHTML(reviewer.title)}</strong>
          <span>${escapeHTML(reviewer.subject)} · ${reviewer.keyPoints.length} key points</span>
        </button>
        <button class="reviewer-delete-button" type="button" data-reviewer-action="delete" aria-label="Delete ${escapeHTML(reviewer.title)}">Delete</button>
      </article>`).join("");
  }
  // Show the selected reviewer's key points and hidden answers.
  function renderReviewer() {
    const reviewer = state.reviewers.find(item => item.id === selectedReviewerId);
    $("#reviewerResults").classList.toggle("hidden", !reviewer);
    $("#emptyReviewerResult").classList.toggle("hidden", Boolean(reviewer));
    $("#deleteReviewer").classList.toggle("hidden", !reviewer);
    if (!reviewer) {
      $("#reviewerResultTitle").textContent = "Your reviewer";
      $("#reviewerResultMeta").textContent = "Create a reviewer or choose one from your library.";
      $("#reviewerKeyPoints").innerHTML = "";
      $("#reviewerQuestions").innerHTML = "";
      return;
    }

    $("#reviewerResultTitle").textContent = reviewer.title;
    $("#reviewerResultMeta").textContent = `${reviewer.subject} · Created ${new Date(reviewer.createdAt).toLocaleDateString()}`;
    $("#reviewerKeyPoints").innerHTML = reviewer.keyPoints.map(point => `<li>${escapeHTML(point)}</li>`).join("");
    $("#reviewerQuestions").innerHTML = reviewer.questions.map((question, index) =>
      `<article class="reviewer-question">
        <p>${index + 1}. ${escapeHTML(question.prompt)}</p>
        <button type="button" data-reviewer-question="${index}" aria-expanded="false">Show answer</button>
        <span class="reviewer-answer hidden">${escapeHTML(question.answer)}</span>
      </article>`
    ).join("");
  }
  // Validate note input, generate a reviewer, and persist it to the profile.
  function handleCreateReviewer(event) {
    event.preventDefault();
    if (!$("#reviewerForm").reportValidity()) return;

    const source = $("#reviewerSource").value.trim();
    const content = createReviewerContent(source);
    if (!content) {
      showToast("Add a few complete sentences so key points and questions can be created.");
      return;
    }

    const reviewer = {
      id: window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: $("#reviewerTitle").value.trim(),
      subject: $("#reviewerSubject").value.trim(),
      source,
      ...content,
      createdAt: Date.now()
    };
    state.reviewers.push(reviewer);
    if (!saveData()) {
      state.reviewers = state.reviewers.filter(item => item.id !== reviewer.id);
      return;
    }
    selectedReviewerId = reviewer.id;
    renderReviewerLibrary();
    renderReviewer();
    $("#reviewerForm").reset();
    showToast("Your personal reviewer is ready and saved.");
  }
  // Open a saved reviewer or pass its deletion to the confirmation handler.
  function handleReviewerLibraryAction(event) {
    const button = event.target.closest("[data-reviewer-action]");
    const row = event.target.closest("[data-reviewer-id]");
    if (!button || !row) return;
    const reviewer = state.reviewers.find(item => item.id === row.dataset.reviewerId);
    if (!reviewer) return;

    if (button.dataset.reviewerAction === "open") {
      selectedReviewerId = reviewer.id;
      renderReviewerLibrary();
      renderReviewer();
      return;
    }
    if (button.dataset.reviewerAction === "delete") deleteReviewer(reviewer);
  }
  // Delete a reviewer only after confirmation and successful persistence.
  function deleteReviewer(reviewer) {
    if (!window.confirm(`Delete "${reviewer.title}"? This action cannot be undone.`)) return;
    const previousReviewers = state.reviewers;
    state.reviewers = state.reviewers.filter(item => item.id !== reviewer.id);
    if (!saveData()) {
      state.reviewers = previousReviewers;
      return;
    }
    if (selectedReviewerId === reviewer.id) selectedReviewerId = null;
    renderReviewerLibrary();
    renderReviewer();
    showToast("Reviewer deleted.");
  }
  // Reveal or hide a practice answer and update its accessible state.
  function toggleReviewerAnswer(event) {
    const button = event.target.closest("[data-reviewer-question]");
    if (!button) return;
    const answer = button.nextElementSibling;
    const expanded = answer.classList.toggle("hidden") === false;
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "Hide answer" : "Show answer";
  }
  // Allocate pending study time across available days before task deadlines.
  function generateSchedule(event) {
    event.preventDefault();
    if (!$("#scheduleForm").reportValidity()) return;
    const selectedDays = $$('input[name="studyDay"]:checked').map(input => Number(input.value)).sort((a, b) => a - b);
    if (!selectedDays.length) {
      showToast("Choose at least one study day.");
      return;
    }

    const settings = {
      dailyMinutes: Number($("#scheduleDailyMinutes").value),
      studyDays: selectedDays,
      startTime: $("#scheduleStartTime").value,
      breakMinutes: Number($("#scheduleBreakMinutes").value),
      horizonDays: Number($("#scheduleHorizon").value)
    };
    state.settings.schedule = settings;

    const now = new Date();
    const today = todayISO();
    const horizonEnd = new Date(`${today}T00:00:00`);
    horizonEnd.setDate(horizonEnd.getDate() + settings.horizonDays - 1);
    const horizonEndISO = formatISODate(horizonEnd);
    const pendingTasks = state.tasks.filter(task => !task.completed);
    const tasks = pendingTasks.map(task => {
      const deadline = getDeadlineDate(task);
      const deadlineDate = deadline ? formatISODate(deadline) : horizonEndISO;
      return {
        task,
        deadline,
        deadlineDate: deadlineDate < today ? today : deadlineDate,
        remainingMinutes: Math.max(15, Number(task.estimatedMinutes) || 60)
      };
    }).sort((a, b) =>
      a.deadlineDate.localeCompare(b.deadlineDate) ||
      ({ High: 0, Medium: 1, Low: 2 }[a.task.priority] ?? 1) - ({ High: 0, Medium: 1, Low: 2 }[b.task.priority] ?? 1) ||
      (Number(a.task.createdAt) || 0) - (Number(b.task.createdAt) || 0)
    );
    const sessions = [];
    const startParts = settings.startTime.split(":").map(Number);
    const configuredStart = startParts[0] * 60 + startParts[1];
    const sessionMinutes = Math.max(1, Math.ceil(getConfiguredDurationSeconds() / 60));
    const todayStart = Math.max(configuredStart, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5);

    for (let date = new Date(`${today}T00:00:00`); formatISODate(date) <= horizonEndISO; date.setDate(date.getDate() + 1)) {
      if (!settings.studyDays.includes(date.getDay())) continue;
      const dateISO = formatISODate(date);
      const startMinute = dateISO === today ? todayStart : configuredStart;
      let elapsedMinutes = 0;
      let studyMinutes = 0;
      let daySessionCount = 0;

      for (const item of tasks) {
        if (item.deadlineDate < dateISO || item.deadlineDate > horizonEndISO || item.remainingMinutes <= 0) continue;
        const dueMinute = item.deadline && formatISODate(item.deadline) === dateISO && item.deadline > now
          ? item.deadline.getHours() * 60 + item.deadline.getMinutes()
          : 24 * 60;
        while (item.remainingMinutes > 0 && studyMinutes < settings.dailyMinutes) {
          const breakMinutes = daySessionCount ? settings.breakMinutes : 0;
          const availableStudy = settings.dailyMinutes - studyMinutes;
          const availableUntilMidnight = 24 * 60 - startMinute - elapsedMinutes - breakMinutes;
          const availableUntilDeadline = dueMinute - startMinute - elapsedMinutes - breakMinutes;
          const duration = Math.min(sessionMinutes, item.remainingMinutes, availableStudy, availableUntilMidnight, availableUntilDeadline);
          if (duration <= 0) break;

          elapsedMinutes += breakMinutes;
          const sessionStart = startMinute + elapsedMinutes;
          const sessionTime = `${String(Math.floor(sessionStart / 60)).padStart(2, "0")}:${String(sessionStart % 60).padStart(2, "0")}`;
          sessions.push({
            taskId: item.task.id,
            title: item.task.title,
            subject: item.task.subject,
            priority: item.task.priority || "Medium",
            date: dateISO,
            startTime: sessionTime,
            minutes: duration
          });
          elapsedMinutes += duration;
          studyMinutes += duration;
          daySessionCount += 1;
          item.remainingMinutes -= duration;
        }
      }
    }

    const unplanned = tasks.filter(item => item.remainingMinutes > 0).map(item => {
      const outsideWindow = item.deadlineDate > horizonEndISO;
      const remainingMinutes = item.remainingMinutes;
      return {
        taskId: item.task.id,
        title: item.task.title,
        subject: item.task.subject,
        remainingMinutes,
        reason: outsideWindow
          ? `Its deadline is outside this ${settings.horizonDays}-day plan window.`
          : `${remainingMinutes} min could not fit before its deadline.`
      };
    });
    state.schedule = {
      generatedAt: Date.now(),
      settings,
      taskSignature: getScheduleTaskSignature(pendingTasks),
      sessions,
      unplanned
    };
    const saved = saveData();
    renderSchedule();
    if (!saved) return;
    if (!pendingTasks.length) {
      showToast("There are no pending tasks to schedule.");
    } else if (sessions.length) {
      showToast(`Schedule generated with ${sessions.length} focused ${sessions.length === 1 ? "session" : "sessions"}.`);
    } else {
      showToast("No sessions could be planned. Check availability and the tasks needing attention.");
    }
  }
  // Start the selected plan item in the standard focus timer.
  function startScheduledSession(event) {
    const button = event.target.closest("[data-schedule-start]");
    if (!button) return;
    const task = state.tasks.find(item => item.id === button.dataset.taskId && !item.completed);
    if (!task) {
      showToast("This task is no longer pending. Generate a new schedule to update your plan.");
      return;
    }
    setTimerMode("single");
    setSessionLength(button.dataset.scheduleStart, 0);
    switchView("focus");
    startTimer();
  }
  // Refresh every view that depends on task or study-record state.
  function renderAll() {
    renderStats(); renderUpcoming(); renderTasks(); renderRecords(); renderSchedule(); renderReviewerLibrary(); renderReviewer();
  }
  // Remove finished tasks while leaving pending work untouched.
  function clearCompletedTasks() {
    const previousCount = state.tasks.length;
    state.tasks = state.tasks.filter(task => !task.completed);
    if (state.tasks.length === previousCount) {
      showToast("No completed tasks to clear.");
      return;
    }
    saveData(); renderAll(); showToast("Completed tasks cleared.");
  }
  // Reset and display the task form, filling it when editing an existing task.
  function openTaskForm(task = null) {
    $("#taskForm").reset();
    clearErrors();
    $("#taskId").value = task?.id || "";
    $("#modalTitle").textContent = task ? "Edit task" : "Add task";
    $("#saveTaskBtn").textContent = task ? "Save changes" : "Save task";
    $("#taskTitle").value = task?.title || "";
    $("#taskSubject").value = task?.subject || "";
    $("#taskDeadline").value = task?.deadline || "";
    $("#taskDeadlineTime").value = task?.deadlineTime || "23:59";
    $("#taskEstimate").value = task?.estimatedMinutes || 60;
    $("#taskNotes").value = task?.notes || "";
    const priority = task?.priority || "Medium";
    $(`input[name="priority"][value="${priority}"]`).checked = true;
    $("#taskModal").classList.remove("hidden");
    $("#taskTitle").focus();
  }
  // Hide the task form and clear its values and validation messages.
  function closeTaskForm() {
    $("#taskModal").classList.add("hidden");
    $("#taskForm").reset();
    clearErrors();
  }
  // Clear validation and form-level messages before another submission.
  function clearErrors() {
    // Clear each field-specific error label.
    ["titleError", "subjectError", "deadlineError", "estimateError"].forEach(id => $(`#${id}`).textContent = "");
    $("#formMessage").classList.add("hidden");
  }
  // Validate required task details and ensure the deadline is a real date and time.
  function validateTask(data) {
    let valid = true;
    if (!data.title.trim()) { $("#titleError").textContent = "Task title is required."; valid = false; }
    if (!data.subject.trim()) { $("#subjectError").textContent = "Subject is required."; valid = false; }
    if (!data.deadline || !data.deadlineTime) {
      $("#deadlineError").textContent = "Please select both a due date and time.";
      valid = false;
    } else if (!getDeadlineDate(data)) {
      $("#deadlineError").textContent = "Enter a valid date and time.";
      valid = false;
    }
    if (!Number.isInteger(data.estimatedMinutes) || data.estimatedMinutes < 15 || data.estimatedMinutes > 600 || data.estimatedMinutes % 15 !== 0) {
      $("#estimateError").textContent = "Enter an estimate from 15 to 600 minutes in 15-minute steps.";
      valid = false;
    }
    return valid;
  }
  // Validate and save the task form, preserving completion information on edits.
  function handleSaveTask(event) {
    event.preventDefault();
    clearErrors();
    const id = $("#taskId").value;
    // Find the saved task so edits retain its creation and completion metadata.
    const existing = state.tasks.find(task => task.id === id);
    const data = {
      id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      title: $("#taskTitle").value.trim(),
      subject: $("#taskSubject").value.trim(),
      deadline: $("#taskDeadline").value,
      deadlineTime: $("#taskDeadlineTime").value,
      estimatedMinutes: Number($("#taskEstimate").value),
      priority: $('input[name="priority"]:checked').value,
      notes: $("#taskNotes").value.trim(),
      completed: existing?.completed || false,
      completedAt: existing?.completedAt || null,
      createdAt: existing?.createdAt || Date.now()
    };
    if (!validateTask(data)) return;
    // Replace the edited item, or append a new task when no matching item exists.
    if (existing) state.tasks = state.tasks.map(task => task.id === id ? data : task);
    else state.tasks.push(data);
    saveData(); closeTaskForm(); renderAll();
    showToast(existing ? "Task updated successfully." : "Task added successfully.");
  }
  // Handle task completion toggles, edits, and confirmed deletions.
  function handleTaskAction(event) {
    const row = event.target.closest("[data-task-id]");
    if (!row) return;
    // Resolve the task associated with the clicked task row.
    const task = state.tasks.find(item => item.id === row.dataset.taskId);
    if (!task) return;
    const action = event.target.dataset.action;
    if (action === "toggle") {
      task.completed = event.target.checked;
      task.completedAt = task.completed ? Date.now() : null;
      saveData(); renderAll();
      showToast(task.completed ? "Task marked as completed." : "Task moved back to pending.");
    } else if (action === "edit") openTaskForm(task);
    else if (action === "delete") {
      if (window.confirm(`Delete "${task.title}"? This action cannot be undone.`)) {
        // Remove only the task the user confirmed deleting.
        state.tasks = state.tasks.filter(item => item.id !== task.id);
        saveData(); renderAll(); showToast("Task deleted.");
      }
    }
  }
  // Update the visible countdown and its accessible progress indicator.
  function updateTimerDisplay() {
    const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
    const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
    $("#timerDisplay").textContent = `${minutes}:${seconds}`;
    const totalSeconds = Math.max(1, getTimerDurationSeconds());
    const progress = Math.min(100, Math.max(0, Math.round((totalSeconds - remainingSeconds) / totalSeconds * 100)));
    $("#timerRing").style.setProperty("--timer-progress", `${progress}%`);
    $("#timerRing").setAttribute("aria-valuenow", progress);
    $("#timerRing").setAttribute("aria-valuetext", `${progress}% complete`);
  }
  // Synchronize the timer's text label and visual state classes.
  function setTimerState(label, className = "") {
    $("#timerState").textContent = label;
    $("#timerRing").classList.remove("running", "paused", "finished", "on-break");
    if (className) $("#timerRing").classList.add(...className.split(" "));
  }
  // Mark the matching preset and disable preset changes during a running session.
  function updateTimerPresets() {
    $$(".preset-button").forEach(button => {
      // A preset is selected only when its minutes match and seconds are zero.
      const selected = Number(button.dataset.minutes) === Number($("#sessionLength").value) &&
        Number($("#sessionSeconds").value) === 0;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = timerRunning || (timerMode === "pomodoro" && pomodoroPhase !== "focus");
    });
  }
  // Select the current focus or break duration in seconds.
  function getTimerDurationSeconds() {
    if (timerMode !== "pomodoro" || pomodoroPhase === "focus") return getConfiguredDurationSeconds();
    const setting = pomodoroPhase === "shortBreak" ? "pomodoroShortBreak" : "pomodoroLongBreak";
    return Number(state.settings[setting]) * 60;
  }
  // Keep mode buttons, duration inputs, and labels in sync with the phase.
  function updatePomodoroControls() {
    const pomodoro = timerMode === "pomodoro";
    $("#singleTimerMode").classList.toggle("active", !pomodoro);
    $("#singleTimerMode").setAttribute("aria-pressed", String(!pomodoro));
    $("#pomodoroTimerMode").classList.toggle("active", pomodoro);
    $("#pomodoroTimerMode").setAttribute("aria-pressed", String(pomodoro));
    $("#singleTimerMode").disabled = timerRunning;
    $("#pomodoroTimerMode").disabled = timerRunning;
    $("#pomodoroOptions").classList.toggle("hidden", !pomodoro);
    $("#pomodoroShortBreak").disabled = timerRunning;
    $("#pomodoroLongBreak").disabled = timerRunning;
    const editingFocus = !pomodoro || pomodoroPhase === "focus";
    $("#sessionLength").disabled = timerRunning || !editingFocus;
    $("#sessionSeconds").disabled = timerRunning || !editingFocus;
    $("#sessionControlLabel").textContent = pomodoro ? "Focus length" : "Session length";
    $("#timerCaption").textContent = pomodoro
      ? pomodoroPhase === "focus" ? "FOCUS ROUND" : pomodoroPhase === "shortBreak" ? "SHORT BREAK" : "LONG BREAK"
      : "TIME TO FOCUS";
    $("#timerRing").setAttribute("aria-label", pomodoro
      ? pomodoroPhase === "focus" ? "Pomodoro focus progress" : "Pomodoro break progress"
      : "Study session progress");
    $("#timerHint").textContent = pomodoro
      ? "Complete four focus rounds to earn a long break."
      : "Tip: Choose one task to focus on until the timer ends.";
    $("#pomodoroCycle").textContent = pomodoroPhase === "longBreak" && pomodoroCount === 4
      ? "4 of 4 focus rounds complete"
      : `${pomodoroCount} of 4 focus rounds complete`;
    $("#startTimer").textContent = pomodoro
      ? pomodoroPhase === "focus" ? "Start focus" : "Start break"
      : "Start";
    updateTimerPresets();
  }
  // Switch timer modes and start a fresh Pomodoro cycle when selected.
  function setTimerMode(mode) {
    if (timerRunning || !["single", "pomodoro"].includes(mode) || timerMode === mode) return;
    timerMode = mode;
    state.settings.timerMode = mode;
    if (mode === "pomodoro") {
      pomodoroPhase = "focus";
      pomodoroCount = 0;
      state.settings.pomodoroPhase = pomodoroPhase;
      state.settings.pomodoroCount = pomodoroCount;
    }
    resetTimer();
    updatePomodoroControls();
    saveData();
  }
  // Validate and save break lengths, refreshing the active break if needed.
  function setPomodoroBreakLength(input, setting, maximum) {
    const minutes = Number(input.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) {
      input.value = state.settings[setting];
      showToast(`Enter a break length from 1 to ${maximum} minutes.`);
      return;
    }
    state.settings[setting] = minutes;
    if (timerMode === "pomodoro" && pomodoroPhase === (setting === "pomodoroShortBreak" ? "shortBreak" : "longBreak")) {
      resetTimer();
    }
    saveData();
  }
  // Create or resume the audio context in response to a user-initiated timer start.
  function prepareCompletionAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      completionAudioUnavailable = true;
      return;
    }
    try {
      if (!completionAudioContext) completionAudioContext = new AudioContextClass();
      if (completionAudioContext.state === "suspended") {
        // Log audio permission or browser failures without interrupting the timer.
        completionAudioContext.resume().catch(error => console.warn("Could not enable STUDISH timer audio:", error));
      }
    } catch (error) {
      completionAudioUnavailable = true;
      console.warn("Could not prepare STUDISH timer audio:", error);
    }
  }
  // Play a short completion melody when the focus timer reaches zero.
  function playCompletionTone(completionLabel = "Focus session complete") {
    if (completionAudioUnavailable || !completionAudioContext || completionAudioContext.state === "closed") {
      showToast(`${completionLabel}. Timer sound is unavailable in this browser.`);
      return;
    }
    // Schedule each note in the completion melody using the active audio context.
    const play = () => {
      // Use two repeated three-note phrases for the completion sound.
      const frequencies = [880, 1175, 880, 988, 1319, 988];
      const startAt = completionAudioContext.currentTime + 0.05;
      // Create one fading oscillator tone for each melody frequency.
      frequencies.forEach((frequency, index) => {
        // Stagger the tones and add a brief pause between the phrases.
        const start = startAt + index * 0.42 + (index >= 3 ? 0.18 : 0);
        const oscillator = completionAudioContext.createOscillator();
        const envelope = completionAudioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(0.14, start + 0.025);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        oscillator.connect(envelope);
        envelope.connect(completionAudioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.36);
      });
    };
    try {
      if (completionAudioContext.state === "suspended") {
        completionAudioContext.resume().then(play).catch(error => {
          // Explain why no sound played while keeping the completed session saved.
          console.warn("Could not play STUDISH timer sound:", error);
          showToast(`${completionLabel}, but the timer sound could not play.`);
        });
      } else {
        play();
      }
    } catch (error) {
      console.warn("Could not play STUDISH timer sound:", error);
      showToast(`${completionLabel}, but the timer sound could not play.`);
    }
  }
  // Start counting down and lock duration controls until the session pauses or ends.
  function startTimer() {
    if (timerRunning) return;
    if (remainingSeconds <= 0) {
      remainingSeconds = getTimerDurationSeconds();
      updateTimerDisplay();
    }
    prepareCompletionAudio();
    timerRunning = true;
    $("#startTimer").disabled = true;
    $("#pauseTimer").disabled = false;
    updatePomodoroControls();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "On break" : "Focusing", onBreak ? "running on-break" : "running");
    $("#timerSubtext").textContent = timerMode === "pomodoro" && pomodoroPhase !== "focus"
      ? "Step away and recharge."
      : "One thing at a time";
    timerInterval = setInterval(tick, 1000);
  }
  // Stop the countdown while keeping the remaining time available to resume.
  function pauseTimer() {
    if (!timerRunning) return;
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    setTimerState("Paused", timerMode === "pomodoro" && pomodoroPhase !== "focus" ? "paused on-break" : "paused");
    $("#timerSubtext").textContent = "Take a breath. Resume when ready.";
  }
  // Stop the countdown and restore the currently configured duration.
  function resetTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    remainingSeconds = getTimerDurationSeconds() || 1;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    updateTimerDisplay();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "Break ready" : "Ready", onBreak ? "on-break" : "");
    $("#timerSubtext").textContent = timerMode === "pomodoro" && pomodoroPhase !== "focus"
      ? "Start your break when you are ready."
      : "Ready to focus";
  }
  // Decrease the timer once per second and finish the session at zero.
  function tick() {
    remainingSeconds = Math.max(0, remainingSeconds - 1);
    updateTimerDisplay();
    if (remainingSeconds === 0) finishTimer();
  }
  // Save a completed focus session, refresh records, and play its completion tone.
  function finishTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    const finishedPhase = pomodoroPhase;
    const durationSeconds = getTimerDurationSeconds();
    let message;
    if (timerMode !== "pomodoro" || finishedPhase === "focus") {
      const minutes = Math.floor(durationSeconds / 60);
      state.records.push({ id: String(Date.now()), minutes, durationSeconds, date: todayISO(), completedAt: Date.now() });
      if (timerMode === "pomodoro") {
        pomodoroCount = Math.min(4, pomodoroCount + 1);
        pomodoroPhase = pomodoroCount === 4 ? "longBreak" : "shortBreak";
        state.settings.pomodoroCount = pomodoroCount;
        state.settings.pomodoroPhase = pomodoroPhase;
        message = pomodoroPhase === "longBreak"
          ? "Pomodoro complete. Your long break is ready."
          : "Focus round complete. Your short break is ready.";
        $("#timerSubtext").textContent = pomodoroPhase === "longBreak"
          ? "Four rounds done. Take a longer break."
          : "Nice work. Take a short break.";
      } else {
        message = `Focus session completed — ${formatStudyTime(durationSeconds)} recorded.`;
        $("#timerSubtext").textContent = "Great work!";
      }
    } else {
      pomodoroPhase = "focus";
      if (finishedPhase === "longBreak") pomodoroCount = 0;
      state.settings.pomodoroCount = pomodoroCount;
      state.settings.pomodoroPhase = pomodoroPhase;
      message = finishedPhase === "longBreak"
        ? "Long break complete. Ready for a fresh Pomodoro cycle."
        : "Break complete. Ready for your next focus round.";
      $("#timerSubtext").textContent = "Recharge complete. Focus when you are ready.";
    }

    remainingSeconds = getTimerDurationSeconds();
    const saved = saveData();
    renderRecords();
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    updateTimerDisplay();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(timerMode === "pomodoro"
      ? onBreak ? "Break ready" : "Focus ready"
      : "Completed", onBreak ? "finished on-break" : "finished");
    if (saved) showToast(message);
    playCompletionTone(timerMode === "pomodoro" && finishedPhase !== "focus" ? "Break complete" : "Focus session complete");
  }
  // Clamp the selected session duration, save it, and restart the timer with that value.
  function setSessionLength(minutesValue = $("#sessionLength").value, secondsValue = $("#sessionSeconds").value) {
    const minutesInput = $("#sessionLength");
    const secondsInput = $("#sessionSeconds");
    let minutes = Number(minutesValue);
    let seconds = Number(secondsValue);
    if (!Number.isFinite(minutes)) minutes = 25;
    if (!Number.isFinite(seconds)) seconds = 0;
    minutes = Math.min(180, Math.max(0, Math.round(minutes)));
    seconds = Math.min(59, Math.max(0, Math.round(seconds)));
    if (minutes === 0 && seconds === 0) seconds = 1;
    minutesInput.value = minutes;
    secondsInput.value = seconds;
    state.settings.sessionLength = minutes;
    state.settings.sessionSeconds = seconds;
    saveData(); resetTimer();
    updatePomodoroControls();
  }
  // Connect page controls to their handlers and render the initial application state.
  function initApp() {
    // Remove the previously installed offline worker and its app-shell cache.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations
          .filter(registration => registration.active?.scriptURL.endsWith("/sw.js"))
          .forEach(registration => registration.unregister());
      }).catch(error => console.warn("Could not remove the STUDISH offline worker:", error));
    }
    if ("caches" in window) {
      caches.keys().then(cacheNames => Promise.all(
        cacheNames.filter(cacheName => cacheName.startsWith("studish-app-")).map(cacheName => caches.delete(cacheName))
      )).catch(error => console.warn("Could not remove the STUDISH offline cache:", error));
    }

    $("#todayLabel").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("#sessionLength").value = state.settings.sessionLength;
    $("#sessionSeconds").value = state.settings.sessionSeconds;
    $("#pomodoroShortBreak").value = state.settings.pomodoroShortBreak;
    $("#pomodoroLongBreak").value = state.settings.pomodoroLongBreak;
    loadScheduleControls();
    $("#sortOrder").value = "deadline";
    if (currentUser) {
      $("#accountGreeting").textContent = `Hi, ${currentUser.name || currentUser.email.split("@")[0]}`;
      $("#authScreen").classList.add("hidden");
      $("#appShell").classList.remove("hidden");
      applyTheme(state.settings.theme || "light");
    } else {
      $("#authScreen").classList.remove("hidden");
      $("#appShell").classList.add("hidden");
      setAuthMode("login");
    }
    remainingSeconds = getTimerDurationSeconds();
    updateTimerDisplay();
    updateTimerPresets();
    updatePomodoroControls();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "Break ready" : "Ready", onBreak ? "on-break" : "");
    $("#timerSubtext").textContent = onBreak ? "Start your break when you are ready." : "Ready when you are";
    $("#authForm").addEventListener("submit", handleAuthSubmit);
    $("#authModeToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
    $("#logoutButton").addEventListener("click", signOut);
    // Switch to the view named by the clicked navigation button.
    $$(".nav-link").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
    // Open a new task form from the dashboard shortcut.
    $("#dashboardAddBtn").addEventListener("click", () => openTaskForm());
    // Open a new task form from the task-list page.
    $("#taskAddBtn").addEventListener("click", () => openTaskForm());
    // Offer task creation when the filtered task list is empty.
    $("#emptyAddBtn").addEventListener("click", () => openTaskForm());
    $("#themeToggle").addEventListener("click", () => applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark"));
    $("#clearCompletedBtn").addEventListener("click", clearCompletedTasks);
    $("#scheduleForm").addEventListener("submit", generateSchedule);
    $("#scheduleDayList").addEventListener("click", startScheduledSession);
    $("#reviewerForm").addEventListener("submit", handleCreateReviewer);
    $("#reviewerLibraryList").addEventListener("click", handleReviewerLibraryAction);
    $("#reviewerQuestions").addEventListener("click", toggleReviewerAnswer);
    $("#deleteReviewer").addEventListener("click", () => {
      const reviewer = state.reviewers.find(item => item.id === selectedReviewerId);
      if (reviewer) deleteReviewer(reviewer);
    });
    // Navigate to the task page when the dashboard link is selected.
    $("#seeAllTasks").addEventListener("click", () => switchView("tasks"));
    $("#closeModal").addEventListener("click", closeTaskForm);
    $("#cancelModal").addEventListener("click", closeTaskForm);
    $("#taskForm").addEventListener("submit", handleSaveTask);
    $("#taskList").addEventListener("click", handleTaskAction);
    $("#taskList").addEventListener("change", handleTaskAction);
    $("#upcomingList").addEventListener("change", handleTaskAction);
    // Refresh task results whenever a search or filter value changes.
    ["searchInput", "subjectFilter", "priorityFilter", "statusFilter", "sortOrder"].forEach(id => {
      $(`#${id}`).addEventListener(id === "searchInput" ? "input" : "change", renderTasks);
    });
    $("#startTimer").addEventListener("click", startTimer);
    $("#pauseTimer").addEventListener("click", pauseTimer);
    $("#resetTimer").addEventListener("click", resetTimer);
    $("#singleTimerMode").addEventListener("click", () => setTimerMode("single"));
    $("#pomodoroTimerMode").addEventListener("click", () => setTimerMode("pomodoro"));
    $("#pomodoroShortBreak").addEventListener("change", () =>
      setPomodoroBreakLength($("#pomodoroShortBreak"), "pomodoroShortBreak", 30));
    $("#pomodoroLongBreak").addEventListener("change", () =>
      setPomodoroBreakLength($("#pomodoroLongBreak"), "pomodoroLongBreak", 60));
    // Normalize and save the edited minute value.
    $("#sessionLength").addEventListener("change", () => setSessionLength());
    // Normalize and save the edited second value.
    $("#sessionSeconds").addEventListener("change", () => setSessionLength());
    // Load the clicked preset's minutes and reset the seconds to zero.
    $$(".preset-button").forEach(button => button.addEventListener("click", () => setSessionLength(button.dataset.minutes, 0)));
    // Dismiss the task form when its backdrop is clicked.
    $("#taskModal").addEventListener("click", event => { if (event.target === $("#taskModal")) closeTaskForm(); });
    // Let Escape dismiss the task dialog when it is open.
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("#taskModal").classList.contains("hidden")) closeTaskForm(); });
    window.addEventListener("beforeunload", saveData);
    renderAll();
    // Refresh the time-sensitive views once per minute.
    setInterval(() => {
      renderStats();
      renderUpcoming();
      renderTasks();
    }, 60000);
  }
  document.addEventListener("DOMContentLoaded", initApp);
})();
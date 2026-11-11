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

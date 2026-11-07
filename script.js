// Keep app state and helper functions private to this page.
(() => {
  "use strict";

  const STORAGE_KEY = "studish_data_v1";
  const DEFAULT_STATE = { tasks: [], records: [], settings: { sessionLength: 25, sessionSeconds: 0 } };
  let state = loadData();
  let timerInterval = null;
  let remainingSeconds = state.settings.sessionLength * 60 + state.settings.sessionSeconds;
  let timerRunning = false;
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

  // Load saved tasks, study records, and settings, filling in missing defaults.
  function loadData() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.tasks) && Array.isArray(saved.records)) {
        return { ...DEFAULT_STATE, ...saved, settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) } };
      }
    } catch (error) { console.warn("Could not load STUDISH data:", error); }
    return structuredClone(DEFAULT_STATE);
  }
  // Persist the current application state and report storage errors to the user.
  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn("Could not save STUDISH data:", error);
      showToast("Unable to save data. Check this browser's storage settings.");
      return false;
    }
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
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // Update dashboard counts and the overall completion progress bar.
  function renderStats() {
    const total = state.tasks.length;
    // Count completed tasks to derive pending work and the completion percentage.
    const completed = state.tasks.filter(task => task.completed).length;
    const pending = total - completed;
    const overdue = state.tasks.filter(isOverdue).length;
    const percentage = total ? Math.round(completed / total * 100) : 0;
    $("#totalStat").textContent = total;
    $("#completedStat").textContent = completed;
    $("#pendingStat").textContent = pending;
    $("#overdueStat").textContent = overdue;
    $("#completionText").textContent = `${percentage}%`;
    $("#completionBar").style.width = `${percentage}%`;
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
    return `<article class="task-row ${task.completed ? "is-complete" : ""} ${overdue ? "is-overdue" : ""}" data-task-id="${escapeHTML(task.id)}">
      <input class="task-check" type="checkbox" aria-label="Mark ${escapeHTML(task.title)} complete" data-action="toggle" ${task.completed ? "checked" : ""}>
      <div class="task-main">
        <p class="task-title">${escapeHTML(task.title)}</p>
        <div class="task-meta"><span>${escapeHTML(task.subject)}</span><span class="separator">|</span><time class="${overdue ? "overdue-text" : ""}" ${deadline ? `datetime="${deadline.toISOString()}"` : ""}>${dateLabel}</time><span class="deadline-badge ${status.className}">${status.label}</span>${completionLabel ? `<time class="task-completed-at" datetime="${completionDate.toISOString()}">${completionLabel}</time>` : ""}</div>
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
    // Keep only tasks matching all active filters.
    const filtered = state.tasks.filter(task => {
      // Test each task against the title, subject, priority, and status controls.
      const matchesSearch = task.title.toLowerCase().includes(search);
      const matchesSubject = !subject || task.subject === subject;
      const matchesPriority = !priority || task.priority === priority;
      const matchesStatus = !status || (status === "completed" ? task.completed : status === "overdue" ? isOverdue(task) : !task.completed && !isOverdue(task));
      return matchesSearch && matchesSubject && matchesPriority && matchesStatus;
      // Sort pending tasks first, then order tasks by their deadline.
    }).sort((a, b) => Number(a.completed) - Number(b.completed) ||
      (getDeadlineDate(a)?.getTime() ?? Infinity) - (getDeadlineDate(b)?.getTime() ?? Infinity));
    // Render each matching task as a full task row.
    $("#taskList").innerHTML = filtered.map(task => taskMarkup(task)).join("");
    $("#taskCountLabel").textContent = `${filtered.length} ${filtered.length === 1 ? "task" : "tasks"}`;
    $("#emptyTasks").classList.toggle("hidden", filtered.length > 0);
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
  // Refresh every view that depends on task or study-record state.
  function renderAll() {
    renderStats(); renderUpcoming(); renderTasks(); renderRecords();
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
    ["titleError", "subjectError", "deadlineError"].forEach(id => $(`#${id}`).textContent = "");
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
    const totalSeconds = Math.max(1, getConfiguredDurationSeconds());
    const progress = Math.min(100, Math.max(0, Math.round((totalSeconds - remainingSeconds) / totalSeconds * 100)));
    $("#timerRing").style.setProperty("--timer-progress", `${progress}%`);
    $("#timerRing").setAttribute("aria-valuenow", progress);
    $("#timerRing").setAttribute("aria-valuetext", `${progress}% complete`);
  }
  // Synchronize the timer's text label and visual state classes.
  function setTimerState(label, className = "") {
    $("#timerState").textContent = label;
    $("#timerRing").classList.remove("running", "paused", "finished");
    if (className) $("#timerRing").classList.add(className);
  }
  // Mark the matching preset and disable preset changes during a running session.
  function updateTimerPresets() {
    $$(".preset-button").forEach(button => {
      // A preset is selected only when its minutes match and seconds are zero.
      const selected = Number(button.dataset.minutes) === Number($("#sessionLength").value) &&
        Number($("#sessionSeconds").value) === 0;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = timerRunning;
    });
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
  function playCompletionTone() {
    if (completionAudioUnavailable || !completionAudioContext || completionAudioContext.state === "closed") {
      showToast("Focus session complete. Timer sound is unavailable in this browser.");
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
          showToast("Focus session complete, but the timer sound could not play.");
        });
      } else {
        play();
      }
    } catch (error) {
      console.warn("Could not play STUDISH timer sound:", error);
      showToast("Focus session complete, but the timer sound could not play.");
    }
  }
  // Start counting down and lock duration controls until the session pauses or ends.
  function startTimer() {
    if (timerRunning) return;
    if (remainingSeconds <= 0) {
      remainingSeconds = getConfiguredDurationSeconds();
      updateTimerDisplay();
    }
    prepareCompletionAudio();
    timerRunning = true;
    $("#startTimer").disabled = true;
    $("#pauseTimer").disabled = false;
    $("#sessionLength").disabled = true;
    $("#sessionSeconds").disabled = true;
    updateTimerPresets();
    setTimerState("Focusing", "running");
    $("#timerSubtext").textContent = "One thing at a time";
    timerInterval = setInterval(tick, 1000);
  }
  // Stop the countdown while keeping the remaining time available to resume.
  function pauseTimer() {
    if (!timerRunning) return;
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true; $("#sessionLength").disabled = false;
    $("#sessionSeconds").disabled = false;
    updateTimerPresets();
    setTimerState("Paused", "paused"); $("#timerSubtext").textContent = "Take a breath. Resume when ready.";
  }
  // Stop the countdown and restore the currently configured duration.
  function resetTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    remainingSeconds = getConfiguredDurationSeconds() || 1;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true; $("#sessionLength").disabled = false;
    $("#sessionSeconds").disabled = false;
    updateTimerPresets();
    updateTimerDisplay(); setTimerState("Ready"); $("#timerSubtext").textContent = "Ready to focus";
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
    const durationSeconds = state.settings.sessionLength * 60 + state.settings.sessionSeconds;
    const minutes = Math.floor(durationSeconds / 60);
    state.records.push({ id: String(Date.now()), minutes, durationSeconds, date: todayISO(), completedAt: Date.now() });
    const saved = saveData();
    renderRecords();
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true; $("#sessionLength").disabled = false;
    setTimerState("Completed", "finished"); $("#timerSubtext").textContent = "Great work!";
    updateTimerPresets();
    if (saved) showToast(`Focus session completed — ${formatStudyTime(durationSeconds)} recorded.`);
    playCompletionTone();
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
    remainingSeconds = state.settings.sessionLength * 60 + state.settings.sessionSeconds;
    updateTimerDisplay();
    updateTimerPresets();
    // Switch to the view named by the clicked navigation button.
    $$(".nav-link").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
    // Open a new task form from the dashboard shortcut.
    $("#dashboardAddBtn").addEventListener("click", () => openTaskForm());
    // Open a new task form from the task-list page.
    $("#taskAddBtn").addEventListener("click", () => openTaskForm());
    // Offer task creation when the filtered task list is empty.
    $("#emptyAddBtn").addEventListener("click", () => openTaskForm());
    // Navigate to the task page when the dashboard link is selected.
    $("#seeAllTasks").addEventListener("click", () => switchView("tasks"));
    $("#closeModal").addEventListener("click", closeTaskForm);
    $("#cancelModal").addEventListener("click", closeTaskForm);
    $("#taskForm").addEventListener("submit", handleSaveTask);
    $("#taskList").addEventListener("click", handleTaskAction);
    $("#taskList").addEventListener("change", handleTaskAction);
    $("#upcomingList").addEventListener("change", handleTaskAction);
    // Refresh task results whenever a search or filter value changes.
    ["searchInput", "subjectFilter", "priorityFilter", "statusFilter"].forEach(id => {
      $(`#${id}`).addEventListener(id === "searchInput" ? "input" : "change", renderTasks);
    });
    $("#startTimer").addEventListener("click", startTimer);
    $("#pauseTimer").addEventListener("click", pauseTimer);
    $("#resetTimer").addEventListener("click", resetTimer);
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
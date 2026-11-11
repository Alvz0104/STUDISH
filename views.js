"use strict";
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

"use strict";
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
